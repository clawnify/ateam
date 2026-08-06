// The connection controller: which engines drive the app. Owns the always-alive
// local engine and holds any connected boxes CONCURRENTLY — one board unions their
// tasks, each task's "environment" being the engine that owns it. Every call is
// routed to the owning engine by createAggregate (main/aggregate.ts); every held
// engine's push-events are forwarded to the renderer. Connecting to a box opens a
// transport — the `attach` relay over OpenSSH, or a WebSocket to its Tailscale
// listener — handshakes (gating the protocol version), and ADDS it: connecting
// never drops the others.

import {
	CH,
	type ClientTransport,
	createRpcClient,
	PROTOCOL_VERSION,
	type ProjectDTO,
	type RpcClient,
	type SystemInfo,
	wsClientTransport,
} from "@ateam/protocol";
import { getAgent } from "@ateam/agents";
import {
	buildCloudInit,
	type ConnectionDTO,
	type Engine,
	endpointUrl,
	hetznerProvider,
	type HostTransport,
	listConnections,
	recordConnection,
	resolveTransport,
	sshClientTransport,
	sshExec,
} from "@ateam/server";
import { app, ipcMain } from "electron";
import WebSocket from "ws";
import { join } from "node:path";
import {
	type CreateBoxSpec,
	type CreateProgressEvent,
	HOST_CH,
	type HostStatus,
	type InstallAgentResult,
	type InstallLogEvent,
	type ProviderOptions,
	type SecretsStatus,
} from "../shared/host";
import { type Aggregate, createAggregate } from "./aggregate";
import {
	createSecretStore,
	generateBoxKey,
	writeSshConfigEntry,
	waitForSsh,
	waitForTailscale,
} from "./box-setup";
import {
	type Backend,
	type BackendEvent,
	localBackend,
	type Router,
	remoteBackend,
} from "./backend";

// The one pre-quoted remote command (ssh space-joins remote args, so `bash -lc`
// must arrive as a single element): a login shell (agent-CLI PATH) execing the
// attach relay. Proven live against the Hetzner box.
const REMOTE_ATTACH = "bash -lc 'exec ateam attach --stdio'";
// The canonical box installer, reused verbatim (single source of truth for how a
// box is set up — the same script the docs tell users to curl by hand).
const INSTALL_URL =
	"https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh";
// Default WebSocket port baked into a provisioned box's Tailscale listener (matches
// the picker's placeholder). The listener only exists if the box is on Tailscale.
const WS_DEFAULT_PORT = 8787;
// Cap a connect: ssh can hang on an auth prompt or an unreachable host with no
// error, and the UI must not wait forever. A live daemon replies in well under this.
const CONNECT_TIMEOUT_MS = 20_000;
// A WebSocket over Tailscale goes HALF-OPEN on NAT/WireGuard idle timeout (and on
// laptop sleep) with no close event — and createRpcClient has no per-call timeout,
// because it relies on onClose to reject in-flight calls. Without a health probe
// the board would simply stop responding, silently and forever. So: ping, and treat
// a failed ping as the close the socket never sent. 15s is well under the ~25s
// typical NAT/WireGuard mapping timeout; the same interval the phone settled on.
// SSH needs none of this — a dead ssh child exits and closes the pipe for real.
const WS_PING_INTERVAL_MS = 15_000;
const WS_PING_TIMEOUT_MS = 10_000;

/** The push-events forwarded from every held backend to every window. */
const FORWARDED: { event: BackendEvent; channel: string }[] = [
	{ event: "taskUpdated", channel: CH.evtTaskUpdated },
	{ event: "taskRemoved", channel: CH.evtTaskRemoved },
	{ event: "loopsUpdated", channel: CH.evtLoopsUpdated },
	{ event: "ptyData", channel: CH.evtPtyData },
	{ event: "ptyExit", channel: CH.evtPtyExit },
];

/** The main-process connection controller (the renderer-facing shape is AteamHost). */
export interface Host {
	/** The stable indirection the IPC bridge registers against once. */
	readonly router: Router;
	list(): Promise<ConnectionDTO[]>;
	connect(alias: string | null): Promise<HostStatus>;
	disconnect(alias: string): void;
	connected(): Promise<HostStatus[]>;
	/** id → owning-engine alias (null = local), from the aggregate's learned registry. */
	origins(): Record<string, string | null>;
	/** Connect the box if needed, then clone+register a repo ON it (from its remote URL). */
	provision(alias: string, input: { cloneUrl: string }): Promise<ProjectDTO>;
	/** Install the ateam engine on a reachable SSH box (idempotent), streaming the
	 *  installer's output, then connect. `dest` is an ssh_config alias or user@host. */
	install(dest: string, opts?: { wsAddr?: string }): Promise<HostStatus>;
	/** Create a box from scratch at a provider, provision it, and connect. */
	createBox(spec: CreateBoxSpec): Promise<HostStatus>;
	/** Install an agent's CLI on a connected box, streaming the log; returns the login step. */
	installAgent(alias: string, agentId: string): Promise<InstallAgentResult>;
	/** Which provisioning secrets are saved (booleans, never the values). */
	secretsStatus(): SecretsStatus;
	/** Persist provider credentials (encrypted). Returns the new saved-status. */
	saveSecrets(patch: { hetznerToken?: string; tailscaleAuthKey?: string }): SecretsStatus;
	/** The provider's real regions + sizes for the given token (or the saved one). */
	providerOptions(token?: string): Promise<ProviderOptions>;
}

export interface HostDeps {
	/** The in-process engine — the default backend and the connections-registry db owner. */
	localEngine: Engine;
	/** Push a channel + args to every live window (main-process multi-window fan-out). */
	broadcast: (channel: string, ...args: unknown[]) => void;
}

export function createHost({ localEngine, broadcast }: HostDeps): Host {
	const db = localEngine.services.db;
	const local = localBackend(localEngine);

	// alias → backend; `null` is the always-held local engine (insertion order: local
	// first). Boxes are added on connect and removed on disconnect.
	const backends = new Map<string | null, Backend>([[null, local]]);
	// Per-alias event unsubscribers, so disconnecting one box stops only its stream.
	const unbinders = new Map<string | null, () => void>();
	// Per-alias health probes (ws only) — cleared on disconnect so a dropped box
	// stops pinging a socket nobody is listening to.
	const probes = new Map<string, ReturnType<typeof setInterval>>();

	// One aggregate over a LIVE backend array: connecting pushes onto it (so the
	// learned id→engine registry survives), disconnecting rebuilds a fresh one (so a
	// gone engine's ids stop routing). Both share the same array reference.
	const backendList: Backend[] = [local];
	let agg: Aggregate = createAggregate(backendList, local);

	function bindEvents(backend: Backend): () => void {
		const offs = FORWARDED.map(({ event, channel }) =>
			backend.on(event, (payload) => broadcast(channel, payload)),
		);
		return () => {
			for (const off of offs) off();
		};
	}
	// Forward the local engine's events from startup; each connected box adds its own.
	unbinders.set(null, bindEvents(local));

	async function statusOf(backend: Backend, alias: string | null): Promise<HostStatus> {
		const info = (await backend.handle(CH.systemHello, [])) as SystemInfo;
		return { mode: backend.kind, alias, info };
	}

	function connected(): Promise<HostStatus[]> {
		return Promise.all([...backends.entries()].map(([alias, b]) => statusOf(b, alias)));
	}

	function broadcastConnections(): void {
		void connected().then((list) => broadcast(HOST_CH.evtConnectionsChanged, list));
	}

	/**
	 * Open the wire to a box. Which wire is a property of the connection, not of
	 * the call site: an ssh_config alias gets the `attach` relay over OpenSSH; a
	 * `host:port` gets a WebSocket to the box's Tailscale listener.
	 *
	 * The `ws` constructor is injected because Electron's MAIN process is Node 20
	 * (electron 34.5.8 → node 20.19.1), which has no global WebSocket — the
	 * renderer and the phone do, the main process doesn't.
	 */
	function openTransport(
		alias: string,
		wire: HostTransport | null,
	): { transport: ClientTransport; close(): void } {
		if (wire === "ws") {
			const url = endpointUrl(alias);
			if (!url) throw new Error(`"${alias}" is not a host:port endpoint`);
			return wsClientTransport(url, WebSocket as never);
		}
		if (wire === null) {
			throw new Error(
				`Unknown connection "${alias}" — add it to ~/.ssh/config, or give a Tailscale endpoint like 100.x.y.z:8787.`,
			);
		}
		return sshClientTransport(alias, [REMOTE_ATTACH]);
	}

	async function connect(alias: string | null): Promise<HostStatus> {
		// local is permanent; connecting to it (or to an already-held box) is a no-op.
		if (alias === null) return statusOf(local, null);
		const existing = backends.get(alias);
		if (existing) return statusOf(existing, alias);

		// Resolve once: the same answer decides which wire to open AND what we save.
		const wire = resolveTransport(db, alias);
		const client = openTransport(alias, wire);
		const rpc: RpcClient = createRpcClient(client.transport);
		let info: SystemInfo;
		try {
			info = await withTimeout(rpc.call(CH.systemHello) as Promise<SystemInfo>, CONNECT_TIMEOUT_MS);
		} catch (err) {
			client.close();
			throw err;
		}
		if (info.protocolVersion !== PROTOCOL_VERSION) {
			client.close();
			throw new Error(
				`Protocol mismatch: "${alias}" speaks v${info.protocolVersion}, this app speaks v${PROTOCOL_VERSION}. Update the older side.`,
			);
		}

		recordConnection(db, {
			hostAlias: alias,
			transport: wire ?? "ssh",
			serverVersion: String(info.protocolVersion),
			agentsAvailable: info.agents,
		});
		// The remote's method set matches the local dispatcher's (same contract).
		const backend = remoteBackend(rpc, local.methods, client.close);
		backends.set(alias, backend);
		backendList.push(backend); // the live aggregate now fans out to it too
		unbinders.set(alias, bindEvents(backend));
		if (wire === "ws") probes.set(alias, startHealthProbe(alias, rpc));
		broadcastConnections();
		return { mode: "remote", alias, info };
	}

	/**
	 * Keep a WebSocket honest. A half-open socket answers nothing and reports
	 * nothing, so we ask it a cheap question on a timer: one unanswered ping means
	 * the connection is gone, and we tear it down exactly as an explicit disconnect
	 * would — disposing it, dropping it from the aggregate so no call routes into a
	 * dead engine, and telling the renderer. A visible disconnect beats a board that
	 * quietly stops working.
	 */
	function startHealthProbe(alias: string, rpc: RpcClient): ReturnType<typeof setInterval> {
		const timer = setInterval(() => {
			void withTimeout(rpc.call(CH.systemHello), WS_PING_TIMEOUT_MS).catch(() => {
				if (backends.has(alias)) disconnect(alias);
			});
		}, WS_PING_INTERVAL_MS);
		// Never hold the app open just to ping a box.
		timer.unref?.();
		return timer;
	}

	function disconnect(alias: string): void {
		const backend = backends.get(alias);
		if (!backend) return; // unknown alias / already gone (null never routes here — it's not a key)
		const probe = probes.get(alias);
		if (probe) {
			clearInterval(probe);
			probes.delete(alias);
		}
		unbinders.get(alias)?.();
		unbinders.delete(alias);
		backend.dispose();
		backends.delete(alias);
		const i = backendList.indexOf(backend);
		if (i >= 0) backendList.splice(i, 1);
		// Rebuild so the learned registry drops the gone engine's ids (no stale routing).
		agg = createAggregate(backendList, local);
		broadcastConnections();
	}

	function origins(): Record<string, string | null> {
		// Invert the aggregate's learned id→Backend registry into id→alias for the renderer.
		const byBackend = new Map<Backend, string | null>();
		for (const [alias, b] of backends) byBackend.set(b, alias);
		const out: Record<string, string | null> = {};
		for (const [id, b] of agg.ownerOf) out[id] = byBackend.get(b) ?? null;
		return out;
	}

	async function install(dest: string, opts?: { wsAddr?: string }): Promise<HostStatus> {
		// Already set up and held — installing again would just re-run the (idempotent)
		// script for no reason; hand back its status.
		const existing = backends.get(dest);
		if (existing) return statusOf(existing, dest);

		const wsAddr = opts?.wsAddr?.trim();
		// A caller-supplied address is interpolated into a remote shell command, so it
		// must be EXACTLY a host:port endpoint — never anything that could break the pipe.
		if (wsAddr && !endpointUrl(wsAddr)) throw new Error(`"${wsAddr}" is not a host:port endpoint`);

		// Reuse install.sh verbatim. With an explicit address, bake it in; otherwise
		// derive the box's OWN tailnet IP on the box, so the phone's WebSocket listener
		// is set up automatically when the box is on Tailscale. An empty ATEAM_WS_ADDR
		// means "daemon service only, no listener" — install.sh treats it as unset.
		const pipeline = wsAddr
			? `curl -fsSL ${INSTALL_URL} | ATEAM_WS_ADDR=${wsAddr} bash -s -- --service`
			: // Single-quoted JS so the shell's ${ip:+…} parameter expansion stays literal.
				"ip=$(command -v tailscale >/dev/null 2>&1 && tailscale ip -4 2>/dev/null | head -1 || true); " +
				`curl -fsSL ${INSTALL_URL} ` +
				'| ATEAM_WS_ADDR="${ip:+$ip:' +
				WS_DEFAULT_PORT +
				'}" bash -s -- --service';

		const result = await sshExec(dest, `bash -lc '${pipeline}'`, {
			onData: (chunk) =>
				broadcast(HOST_CH.evtInstallLog, { dest, chunk } satisfies InstallLogEvent),
		});
		if (result.code !== 0) {
			throw new Error(`Setup of "${dest}" failed — ssh exited ${result.code ?? "on a signal"}.`);
		}

		// We just reached the box over SSH, so its transport is ssh — seed that row so
		// connect() resolves it even when `dest` is a user@host with no ssh_config entry.
		recordConnection(db, { hostAlias: dest, transport: "ssh" });
		return connect(dest);
	}

	// The encrypted provider-credentials store, created lazily (needs app to be ready).
	let secretsStore: ReturnType<typeof createSecretStore> | null = null;
	const secrets = () =>
		(secretsStore ??= createSecretStore(join(app.getPath("userData"), "provider-secrets.enc")));

	function secretsStatus(): SecretsStatus {
		const s = secrets().load();
		return { hetznerToken: !!s.hetznerToken, tailscaleAuthKey: !!s.tailscaleAuthKey };
	}

	function saveSecrets(patch: { hetznerToken?: string; tailscaleAuthKey?: string }): SecretsStatus {
		secrets().save(patch);
		return secretsStatus();
	}

	function providerOptions(token?: string): Promise<ProviderOptions> {
		const t = (token || secrets().load().hetznerToken || "").trim();
		if (!t) throw new Error("Enter your Hetzner API token to load regions and sizes.");
		return hetznerProvider.fetchOptions(t);
	}

	/** A DNS-label alias from a free-text box name (also the Tailscale hostname). */
	function sanitizeName(raw: string): string {
		const s = raw
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 63)
			.replace(/-+$/g, "");
		if (!s) throw new Error("Please give the box a name (letters, digits, or dashes).");
		return s;
	}

	async function createBox(spec: CreateBoxSpec): Promise<HostStatus> {
		const alias = sanitizeName(spec.name);
		const saved = secrets().load();
		const token = (spec.hetznerToken || saved.hetznerToken || "").trim();
		const tsKey = (spec.tailscaleAuthKey || saved.tailscaleAuthKey || "").trim();
		if (!token) throw new Error("A Hetzner API token is required.");
		if (!tsKey) throw new Error("A Tailscale auth key is required.");
		// Remember whatever we used, so the next box needs no re-entry.
		secrets().save({ hetznerToken: token, tailscaleAuthKey: tsKey });

		const progress = (stage: string) =>
			broadcast(HOST_CH.evtCreateProgress, { alias, stage } satisfies CreateProgressEvent);

		progress("Generating an SSH key");
		const { publicKey, privateKeyPath } = generateBoxKey(app.getPath("userData"), alias);
		const cloudInit = buildCloudInit({
			hostname: alias,
			sshPublicKey: publicKey,
			tailscaleAuthKey: tsKey,
		});

		const server = await hetznerProvider.createServer({
			token,
			name: alias,
			region: spec.region,
			size: spec.size,
			sshPublicKey: publicKey,
			cloudInit,
			onProgress: progress,
		});

		progress("Configuring SSH access");
		// The alias may be suffixed to dodge a pre-existing ~/.ssh/config entry, so use
		// what was actually written for every subsequent SSH (never the raw name).
		const boxAlias = writeSshConfigEntry(alias, server.publicIp, privateKeyPath);

		progress("Waiting for the box to boot");
		await waitForSsh(boxAlias);

		progress("Joining Tailscale");
		const onTailnet = await waitForTailscale(boxAlias);
		if (!onTailnet) {
			progress(
				"Tailscale didn't come up — installing anyway; the phone won't connect until it's fixed",
			);
		}

		// Reuse the streamed installer (Gap A): it derives the box's tailnet IP into
		// ATEAM_WS_ADDR (so the phone can connect) and connects on success.
		progress("Installing the engine");
		const status = await install(boxAlias);

		// Preinstall any requested agent CLIs (best-effort — the box is usable without
		// them, and the OAuth login is a separate step the user does after).
		for (const agentId of spec.agents ?? []) {
			progress(`Installing ${getAgent(agentId)?.label ?? agentId}`);
			try {
				await installAgent(boxAlias, agentId);
			} catch (err) {
				progress(
					`Couldn't install ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		return status;
	}

	async function installAgent(alias: string, agentId: string): Promise<InstallAgentResult> {
		const agent = getAgent(agentId);
		if (!agent?.install) throw new Error(`Don't know how to install "${agentId}".`);
		if (!backends.has(alias)) throw new Error(`Not connected to "${alias}".`);
		// Run the official installer in a login shell (PATH/profile set up), then confirm
		// the binary is on the login PATH the daemon will actually spawn it from.
		const remote = `bash -lc '${agent.install} && command -v ${agent.bin}'`;
		const result = await sshExec(alias, remote, {
			onData: (chunk) =>
				broadcast(HOST_CH.evtInstallLog, { dest: alias, chunk } satisfies InstallLogEvent),
		});
		if (result.code !== 0) {
			throw new Error(
				`Installing ${agent.label} on "${alias}" failed (exit ${result.code ?? "on a signal"}) — it may have installed but not landed on the login PATH.`,
			);
		}
		// The box's agent list now includes it — refresh so the composer's env-agents update.
		broadcastConnections();
		return { agentId, loginCommand: agent.loginCommand };
	}

	async function provision(alias: string, input: { cloneUrl: string }): Promise<ProjectDTO> {
		// Provisioning targets a SPECIFIC engine — the aggregate routes by learned id,
		// but there's no id on the box yet, so call that backend's clone directly.
		await connect(alias); // idempotent if already held
		const backend = backends.get(alias);
		if (!backend) throw new Error(`Not connected to "${alias}"`);
		return backend.handle(CH.projectsClone, [input]) as Promise<ProjectDTO>;
	}

	const router: Router = {
		methods: local.methods,
		handle: (method, args) => agg.handle(method, args),
	};

	return {
		router,
		list: async (): Promise<ConnectionDTO[]> => listConnections(db),
		connect,
		disconnect,
		connected,
		origins,
		provision,
		install,
		createBox,
		installAgent,
		secretsStatus,
		saveSecrets,
		providerOptions,
	};
}

/** Register the connection-control IPC channels against a host. Call once. */
export function registerHostIpc(host: Host): void {
	ipcMain.handle(HOST_CH.list, () => host.list());
	ipcMain.handle(HOST_CH.connect, (_e, alias: string | null) => host.connect(alias));
	ipcMain.handle(HOST_CH.disconnect, (_e, alias: string) => host.disconnect(alias));
	ipcMain.handle(HOST_CH.connected, () => host.connected());
	ipcMain.handle(HOST_CH.origins, () => host.origins());
	ipcMain.handle(HOST_CH.provision, (_e, alias: string, input: { cloneUrl: string }) =>
		host.provision(alias, input),
	);
	ipcMain.handle(HOST_CH.install, (_e, dest: string, opts?: { wsAddr?: string }) =>
		host.install(dest, opts),
	);
	ipcMain.handle(HOST_CH.createBox, (_e, spec: CreateBoxSpec) => host.createBox(spec));
	ipcMain.handle(HOST_CH.installAgent, (_e, alias: string, agentId: string) =>
		host.installAgent(alias, agentId),
	);
	ipcMain.handle(HOST_CH.secretsStatus, () => host.secretsStatus());
	ipcMain.handle(
		HOST_CH.saveSecrets,
		(_e, patch: { hetznerToken?: string; tailscaleAuthKey?: string }) => host.saveSecrets(patch),
	);
	ipcMain.handle(HOST_CH.providerOptions, (_e, token?: string) => host.providerOptions(token));
}

/** Reject (and clean up) if a promise doesn't settle in time. */
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
