// The connection controller: which engines drive the app. Owns the always-alive
// local engine and holds any connected boxes CONCURRENTLY — one board unions their
// tasks, each task's "environment" being the engine that owns it. Every call is
// routed to the owning engine by createAggregate (main/aggregate.ts); every held
// engine's push-events are forwarded to the renderer. Connecting to a box opens an
// SSH transport (the `attach` relay over OpenSSH), handshakes (gating the protocol
// version), and ADDS it — connecting never drops the others.

import {
	CH,
	createRpcClient,
	PROTOCOL_VERSION,
	type ProjectDTO,
	type RpcClient,
	type SystemInfo,
} from "@ateam/protocol";
import {
	type ConnectionDTO,
	type Engine,
	listConnections,
	recordConnection,
	sshClientTransport,
} from "@ateam/server";
import { ipcMain } from "electron";
import { HOST_CH, type HostStatus } from "../shared/host";
import { type Aggregate, createAggregate } from "./aggregate";
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
// Cap a connect: ssh can hang on an auth prompt or an unreachable host with no
// error, and the UI must not wait forever. A live daemon replies in well under this.
const CONNECT_TIMEOUT_MS = 20_000;

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

	async function connect(alias: string | null): Promise<HostStatus> {
		// local is permanent; connecting to it (or to an already-held box) is a no-op.
		if (alias === null) return statusOf(local, null);
		const existing = backends.get(alias);
		if (existing) return statusOf(existing, alias);

		const client = sshClientTransport(alias, [REMOTE_ATTACH]);
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
			serverVersion: String(info.protocolVersion),
			agentsAvailable: info.agents,
		});
		// The remote's method set matches the local dispatcher's (same contract).
		const backend = remoteBackend(rpc, local.methods, client.close);
		backends.set(alias, backend);
		backendList.push(backend); // the live aggregate now fans out to it too
		unbinders.set(alias, bindEvents(backend));
		broadcastConnections();
		return { mode: "remote", alias, info };
	}

	function disconnect(alias: string): void {
		const backend = backends.get(alias);
		if (!backend) return; // unknown alias / already gone (null never routes here — it's not a key)
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
