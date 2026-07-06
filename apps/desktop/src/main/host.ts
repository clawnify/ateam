// The connection controller: which engine drives the app, and swapping between
// them. Owns the always-alive local engine, the currently-active Backend, and the
// forwarding of that backend's push-events to the renderer. Connecting to a remote
// host opens an SSH transport, handshakes (gating the protocol version), caches the
// result, and re-points the active backend + event stream at it.
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import {
	CH,
	createRpcClient,
	PROTOCOL_VERSION,
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
import { type Backend, type BackendEvent, localBackend, remoteBackend, type Router } from "./backend";
import { HOST_CH, type HostStatus } from "../shared/host";

// The one pre-quoted remote command (ssh space-joins remote args, so `bash -lc`
// must arrive as a single element): a login shell (agent-CLI PATH) execing the
// attach relay. Proven live against the Hetzner box.
const REMOTE_ATTACH = "bash -lc 'exec ateam attach --stdio'";
// Cap a connect: ssh can hang on an auth prompt or an unreachable host with no
// error, and the UI must not wait forever. A live daemon replies in well under this.
const CONNECT_TIMEOUT_MS = 20_000;

/** The four push-events forwarded from the active backend to the renderer. */
const FORWARDED: { event: BackendEvent; channel: string }[] = [
	{ event: "taskUpdated", channel: CH.evtTaskUpdated },
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
	current(): Promise<HostStatus>;
}

export interface HostDeps {
	/** The in-process engine — the default backend and the connections-registry db owner. */
	localEngine: Engine;
	/** The window to forward events to (may be null before it's created). */
	getWin: () => BrowserWindow | null;
}

export function createHost({ localEngine, getWin }: HostDeps): Host {
	const db = localEngine.services.db;
	const local = localBackend(localEngine);

	let active: Backend = local;
	let activeAlias: string | null = null;
	// Bind the local engine's events immediately so it forwards from startup; swaps
	// re-bind. Guarded by getWin() at emit time, so a not-yet-created window is fine.
	let unbindEvents: () => void = bindEvents(local);

	function bindEvents(backend: Backend): () => void {
		const offs = FORWARDED.map(({ event, channel }) =>
			backend.on(event, (payload) => getWin()?.webContents.send(channel, payload)),
		);
		return () => {
			for (const off of offs) off();
		};
	}

	async function statusOf(backend: Backend, alias: string | null): Promise<HostStatus> {
		const info = (await backend.handle(CH.systemHello, [])) as SystemInfo;
		return { mode: backend.kind, alias, info };
	}

	function swap(next: Backend, alias: string | null): void {
		// Never dispose the local engine — it stays alive as the default backend and
		// owns the connections-registry db.
		if (active !== local && active !== next) active.dispose();
		unbindEvents();
		active = next;
		activeAlias = alias;
		unbindEvents = bindEvents(next);
		void statusOf(next, alias).then((status) =>
			getWin()?.webContents.send(HOST_CH.evtChanged, status),
		);
	}

	async function connect(alias: string | null): Promise<HostStatus> {
		if (alias === null) {
			swap(local, null);
			return statusOf(local, null);
		}

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
		swap(remoteBackend(rpc, local.methods, client.close), alias);
		return { mode: "remote", alias, info };
	}

	const router: Router = {
		methods: local.methods,
		handle: (method, args) => active.handle(method, args),
	};

	return {
		router,
		list: async (): Promise<ConnectionDTO[]> => listConnections(db),
		connect,
		current: (): Promise<HostStatus> => statusOf(active, activeAlias),
	};
}

/** Register the connection-control IPC channels against a host. Call once. */
export function registerHostIpc(host: Host): void {
	ipcMain.handle(HOST_CH.list, () => host.list());
	ipcMain.handle(HOST_CH.connect, (_e, alias: string | null) => host.connect(alias));
	ipcMain.handle(HOST_CH.current, () => host.current());
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
