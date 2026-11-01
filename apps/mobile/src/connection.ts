// The phone's link to a box: open a WebSocket to the box's opt-in `ateam` WS
// listener (reachable over Tailscale), handshake the protocol version, then bind
// the full AteamApi over it. React Native can't spawn `ssh` like the desktop, but
// it ships a WebSocket — and @ateam/protocol is pure TS, so buildAteamApi runs
// here unchanged. This is the whole client: everything else is the shared contract.
import {
	type AteamApi,
	type BrowserViewDTO,
	browserViewUrl,
	buildAteamApi,
	CH,
	createRpcClient,
	type LeadClient,
	leadClient,
	type NativeClientApi,
	PROTOCOL_VERSION,
	type ProjectDTO,
	type RemoteRepoDTO,
	requestBoxUpdate,
	type SystemInfo,
	serverHandshake,
	tolerantRpc,
	wsClientTransport,
} from "@ateam/protocol";

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
	api: AteamApi;
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
	 * silently fall back to the local machine. The phone holds exactly one box, so
	 * here the question doesn't arise. Gate `repos` on FEATURE_MIN_VERSION
	 * .githubProjects — a pre-v9 box rejects it as an unknown method.
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
}

const CONNECT_TIMEOUT_MS = 15_000;
const PING_TIMEOUT_MS = 4_000;

/** Connect to `ws://host:port` (the box's Tailscale address + WS port). */
export async function connect(url: string, opts: ConnectOptions = {}): Promise<Connection> {
	const client = wsClientTransport(url);
	const rpc = createRpcClient(client.transport);

	// Distinguish an app-initiated close() from an unexpected drop: only the latter
	// should trigger a reattach. Registered before the handshake so a drop mid-connect
	// is still classified correctly (the throw path below sets `intentional`).
	let intentional = false;
	client.transport.onClose?.(() => {
		if (!intentional) opts.onClose?.();
	});

	let info: SystemInfo;
	try {
		// A bad host / firewalled port leaves the socket hanging with no error, so
		// cap the handshake — the UI must not wait forever on connect.
		info = await withTimeout(serverHandshake(rpc), CONNECT_TIMEOUT_MS);
	} catch (err) {
		intentional = true; // a failed connect isn't a drop to reattach from
		client.close();
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
	const keepalive = setInterval(() => {
		void serverHandshake(rpc).catch(() => {});
	}, 15_000);

	// The box's browser view answers on the box's tailnet address, the same host
	// this socket dialed, so the engine's port is all it takes to reach it.
	const native: NativeClientApi = {
		...mobileNative,
		browserView: async (taskId) => {
			const view = (await rpc.call(CH.browserView, [taskId])) as BrowserViewDTO;
			return { url: browserViewUrl(`http://${boxHost(url)}:${view.port}`, view.password) };
		},
	};

	return {
		api: buildAteamApi(tolerantRpc(rpc, info.protocolVersion), native),
		info,
		skewed,
		update: () => requestBoxUpdate(rpc),
		box: {
			repos: () => rpc.call(CH.projectsRemoteRepos, []) as Promise<RemoteRepoDTO[]>,
			clone: (cloneUrl: string) =>
				rpc.call(CH.projectsClone, [{ cloneUrl }]) as Promise<ProjectDTO>,
		},
		lead: leadClient(rpc),
		ping: () =>
			withTimeout(serverHandshake(rpc), PING_TIMEOUT_MS).then(
				() => true,
				() => false,
			),
		close: () => {
			intentional = true;
			clearInterval(keepalive);
			client.close();
		},
	};
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
