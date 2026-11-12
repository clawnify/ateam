// The phone uses tailnet WebSockets or native SSH stdio for the same Ateam RPC.
import {
	type AteamApi,
	type BrowserViewDTO,
	browserViewUrl,
	buildAteamApi,
	CH,
	type ClientTransport,
	createRpcClient,
	type LeadClient,
	leadClient,
	type NativeClientApi,
	NEEDS_PAIRING,
	type PairingGrantDTO,
	type PairingState,
	PROTOCOL_VERSION,
	type ProjectDTO,
	pairingClient,
	type RemoteRepoDTO,
	type RpcClient,
	requestBoxUpdate,
	type SystemInfo,
	serverHandshake,
	tolerantRpc,
	wsClientTransport,
} from "@ateam/protocol";
import type { SavedConnection } from "./storage";

// A remote client owns no local dialogs or clipboard: folder-pick and image
// attach flow over RPC (fs.listDir / util.writeImageBytes) instead, so this
// client-native slice is inert here. Single-window, so the window surface stubs too.
export const mobileNative: NativeClientApi = {
	pathForFile: () => "",
	pick: async () => null,
	pickFiles: async () => [],
	attachImages: async () => ({ mode: "none" as const }),
	attachClipboardImage: async () => ({ mode: "none" as const }),
	openProject: async () => {},
	boundProjectId: () => null,
};

export interface Connection {
	/** Reach a loopback service through SSH, or the box address on a tailnet. */
	httpUrl?(port: number): Promise<string>;
	api: AteamApi;
	/** The RPC under `api`, read through tolerantRpc: what the merged board
	 *  (src/fleet.ts) routes this box's share of every call to. */
	rpc: RpcClient;
	info: SystemInfo;
	/** True when the box speaks a different wire contract than this app. The
	 *  connection is live either way; this is what the UI warns about. */
	skewed: boolean;
	/** Fast liveness probe — a timed handshake. False if the socket is dead/half-open. */
	ping(): Promise<boolean>;
	/**
	 * Tell the box to install the current release over itself. Resolves when the
	 * installer has been LAUNCHED, after which this socket drops on purpose and
	 * `onClose` fires: the engine is being replaced. Reconnect to see the new one.
	 *
	 * Rejects on a box older than v7, which has no such method. That box has to be
	 * updated once from a Mac over SSH before the phone can ever drive it, and no
	 * client-side trick avoids that: the capability has to exist on the box first.
	 */
	update(): Promise<{ started: boolean; logPath: string }>;
	/**
	 * Calls that address THIS box rather than an entity on it. They stay off
	 * AteamApi for the same reason `update` does: a client holding several engines
	 * has no answer to "which one?", so the aggregate cannot route them and would
	 * silently fall back to the local machine. The phone's merged board refuses them
	 * (src/fleet.ts), so they go through the Connection of the box they're about.
	 * Gate `repos` on FEATURE_MIN_VERSION.githubProjects — a pre-v9 box rejects it
	 * as an unknown method.
	 */
	box: {
		/** Every GitHub repo this box's `gh` can see, most recently pushed first. */
		repos(): Promise<RemoteRepoDTO[]>;
		/** Clone one onto the box and register it as a project. Idempotent: a repo
		 *  already cloned there is just registered. */
		clone(cloneUrl: string): Promise<ProjectDTO>;
	};
	/** The box's own Lead chat, run by its engine. A box before v24 answers every
	 *  call "Unknown method": gate on boxSupports("lead", info.protocolVersion). */
	lead: LeadClient;
	/** How this phone may use the box (v29): "open" when anyone on the network
	 *  may, "paired" with this phone's token. Absent from an older box (open). */
	pairing: PairingState | undefined;
	/** Lock an open box (v29), pairing this phone first: its token, to keep. */
	lock(label: string): Promise<PairingGrantDTO>;
	/** Close the socket; the daemon and its live sessions live on. */
	close(): void;
}

export interface ConnectOptions {
	/**
	 * Fired once when the socket drops on its OWN (network flip, box restart, NAT
	 * reap) — NOT when the app calls `close()`. The app uses this to auto-reattach
	 * to the still-alive daemon session. See the connectivity decision doc.
	 */
	onClose?: () => void;
	/** This phone's device token for the box, when it is paired with it (v29). */
	token?: string;
	/** The waits below, shortened by a test. */
	timing?: { stallProbeMs?: number; pingTimeoutMs?: number };
}

/** What a call rejects with when its socket is gone (packages/protocol/src/rpc.ts). */
export const RPC_CLOSED = "RPC connection closed";

const CONNECT_TIMEOUT_MS = 15_000;
const PING_TIMEOUT_MS = 4_000;
// A call still unanswered after this long has the socket probed there and then,
// rather than at the next keepalive: a half-open socket otherwise held a screen on
// its spinner, the box still shown as connected, for up to 19 s.
const STALL_PROBE_MS = 5_000;

/**
 * A transport this file can declare gone. Closing a socket whose far end no longer
 * answers starts a closing handshake that nothing completes, so its close event can
 * come long after (or never): the calls in flight kept waiting and the box kept
 * showing as connected. `kill` fires the close handlers now, once; the socket's own
 * event, should it come later, is then ignored.
 */
function killable(t: ClientTransport): { transport: ClientTransport; kill(): void } {
	const handlers: (() => void)[] = [];
	let gone = false;
	const kill = () => {
		if (gone) return;
		gone = true;
		for (const h of handlers) h();
	};
	t.onClose?.(kill);
	return {
		transport: {
			send: (frame) => t.send(frame),
			onFrame: (handler) => t.onFrame(handler),
			onClose: (handler) => void handlers.push(handler),
		},
		kill,
	};
}

/** Connect using the saved transport, retaining URL support for tailnet callers. */
export async function connect(
	address: string | SavedConnection,
	opts: ConnectOptions = {},
): Promise<Connection> {
	const url =
		typeof address === "string" ? address : `ws://${address.host}:${address.port || "8787"}`;
	const client =
		typeof address !== "string" && address.ssh
			? await (await import("./ssh")).sshClient(address)
			: wsClientTransport(url);
	const httpUrl = async (port: number) => {
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
		return "httpUrl" in client ? client.httpUrl(port) : `http://${boxHost(url)}:${port}`;
	};
	const wire = killable(client.transport);
	const raw = createRpcClient(wire.transport);
	const pingMs = opts.timing?.pingTimeoutMs ?? PING_TIMEOUT_MS;
	const stallMs = opts.timing?.stallProbeMs ?? STALL_PROBE_MS;

	// Distinguish an app-initiated close() from an unexpected drop: only the latter
	// should trigger a reattach. Registered before the handshake so a drop mid-connect
	// is still classified correctly (the throw path below sets `intentional`).
	let intentional = false;
	let gone = false;
	wire.transport.onClose?.(() => {
		gone = true;
		if (!intentional) opts.onClose?.();
	});
	// The socket is closed and declared gone at once: the calls in flight reject and
	// `onClose` fires now, not when (if ever) the socket's own close event arrives.
	const shut = () => {
		clearInterval(keepalive);
		client.close();
		wire.kill();
	};
	let keepalive: ReturnType<typeof setInterval> | undefined;
	// One probe at a time: a timed handshake, the socket shut if it goes unanswered.
	let probing = false;
	const probe = () => {
		if (probing || gone) return;
		probing = true;
		withTimeout(serverHandshake(raw), pingMs).then(
			() => {
				probing = false;
			},
			() => shut(),
		);
	};
	// Every call the app makes goes through here. One that is slow to answer has the
	// socket probed (a slow call on a live socket just carries on); one made after the
	// socket is gone rejects, where it would otherwise wait on a reply forever.
	const rpc: RpcClient = {
		on: raw.on,
		call(method, args) {
			if (gone) return Promise.reject(new Error(RPC_CLOSED));
			const p = raw.call(method, args);
			const timer = setTimeout(probe, stallMs);
			const done = () => clearTimeout(timer);
			p.then(done, done);
			return p;
		},
	};

	let info: SystemInfo;
	try {
		// A bad host / firewalled port leaves the socket hanging with no error, so
		// cap the handshake — the UI must not wait forever on connect.
		info = await withTimeout(serverHandshake(raw, opts.token), CONNECT_TIMEOUT_MS);
		// A locked box gives an unpaired phone nothing but a way to pair: say so
		// rather than hold a connection that can't be used.
		if (info.pairing?.state === "needed") throw new Error(NEEDS_PAIRING);
	} catch (err) {
		intentional = true; // a failed connect isn't a drop to reattach from
		shut();
		throw err;
	}
	// A skew is no longer a refusal. Refusing was total: it made a box on last
	// month's release unusable from the phone, and the only advice it could give
	// ("open your Mac") is useless to someone who is out with a phone. The version
	// is advisory now, replies are read through tolerantRpc so an older engine's
	// cards can't crash this app, and the UI says the box is skewed. update() is
	// the way out from here, which is what makes the warning actionable at all.
	const skewed = info.protocolVersion !== PROTOCOL_VERSION;

	// Keepalive: a WS over Tailscale on a phone goes half-open on NAT/WireGuard idle
	// timeout with no close event — a later RPC then hangs forever. A periodic cheap
	// call (system:hello) keeps outbound traffic flowing so the mapping stays live.
	// 15s is well under typical NAT/WireGuard (25s) timeouts. Cleared on close.
	keepalive = setInterval(probe, 15_000);

	// The box's browser view answers on the box's tailnet address, the same host
	// this socket dialed, so the engine's port is all it takes to reach it.
	const native: NativeClientApi = {
		...mobileNative,
		browserView: async (taskId) => {
			const view = (await rpc.call(CH.browserView, [taskId])) as BrowserViewDTO;
			return { url: browserViewUrl(await httpUrl(view.port), view.password, view.controlToken) };
		},
	};

	const tolerant = tolerantRpc(rpc, info.protocolVersion);
	return {
		httpUrl,
		api: buildAteamApi(tolerant, native),
		rpc: tolerant,
		info,
		skewed,
		update: () => requestBoxUpdate(rpc),
		box: {
			repos: () => rpc.call(CH.projectsRemoteRepos, []) as Promise<RemoteRepoDTO[]>,
			clone: (cloneUrl: string) =>
				rpc.call(CH.projectsClone, [{ cloneUrl }]) as Promise<ProjectDTO>,
		},
		lead: leadClient(rpc),
		pairing: typeof address !== "string" && address.ssh ? undefined : info.pairing,
		lock: (label: string) => pairingClient(rpc).lock(label, "phone"),
		ping: () =>
			gone
				? Promise.resolve(false)
				: withTimeout(serverHandshake(raw), pingMs).then(
						() => true,
						() => false,
					),
		close: () => {
			intentional = true;
			shut();
		},
	};
}

/**
 * Pair this phone with a locked box: trade a one-time code (from a paired
 * device's Pair a phone, or `ateam pair` on the box) for its own device token,
 * over a connection of its own that closes again. Keep the token and pass it
 * to `connect`.
 */
export async function redeemPairing(url: string, code: string, label: string): Promise<string> {
	const client = wsClientTransport(url);
	const rpc = createRpcClient(client.transport);
	try {
		const grant = await withTimeout(
			pairingClient(rpc).redeem(code, label, "phone"),
			CONNECT_TIMEOUT_MS,
		);
		return grant.token;
	} finally {
		client.close();
	}
}

/** The host of a `ws://host:port` URL, brackets kept for IPv6. Not `new URL`:
 *  React Native's doesn't implement `hostname`. */
export function boxHost(wsUrl: string): string {
	return wsUrl.replace(/^wss?:\/\//, "").match(/^(\[[^\]]+\]|[^/:]+)/)?.[1] ?? "";
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`connection timed out after ${ms}ms`)), ms);
		p.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}
