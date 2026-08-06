// The desktop's connection-control contract: which engine drives the app. This
// is renderer↔main IPC *about choosing an engine* — deliberately separate from
// window.ateam (the engine surface itself), mirroring how @ateam/server keeps
// connection management off AteamApi. Imports only @ateam/protocol (dependency-
// free), so both the node (main/preload) and web (renderer) tsconfigs resolve it.
import type { ConnectionDTO, ProjectDTO, SystemInfo } from "@ateam/protocol";

/** Renderer↔main channels for listing/choosing/observing the connected engines. */
export const HOST_CH = {
	list: "host:list",
	connect: "host:connect",
	disconnect: "host:disconnect",
	/** All currently-held engines (local is always present). */
	connected: "host:connected",
	/** projectId/taskId → owning engine alias (null = local), for per-origin badges/routing. */
	origins: "host:origins",
	/** Clone+register a repo onto a specific box (connect it first). */
	provision: "host:provision",
	/** Install the ateam engine on a reachable SSH box, then connect to it. */
	install: "host:install",
	evtConnectionsChanged: "evt:host:connections",
	/** Streamed installer output (stdout+stderr) during host:install. */
	evtInstallLog: "evt:host:install-log",
} as const;

/** One chunk of installer output, tagged with the destination it came from. */
export interface InstallLogEvent {
	/** The SSH destination being set up (ssh_config alias or user@host). */
	dest: string;
	chunk: string;
}

/** Which engine is driving the app right now. */
export interface HostStatus {
	mode: "local" | "remote";
	/** ssh_config alias when remote; null for the in-process local engine. */
	alias: string | null;
	/** The engine's handshake: protocol version + the agents its machine has. */
	info: SystemInfo;
}

/**
 * window.ateamHost — the connection-control surface. The desktop holds SEVERAL
 * engines at once (the local Mac + any connected boxes); window.ateam routes each
 * call to whichever engine owns the entity (see main/aggregate.ts). `connect(alias)`
 * adds a box (additive — local is never dropped); `disconnect(alias)` removes one.
 */
export interface AteamHost {
	list(): Promise<ConnectionDTO[]>;
	/** Add an engine (idempotent if already held). `null` is a no-op — local is permanent. */
	connect(alias: string | null): Promise<HostStatus>;
	/** Drop a connected box (never local). */
	disconnect(alias: string): Promise<void>;
	/** Every engine currently held (local first). */
	connected(): Promise<HostStatus[]>;
	/** id → owning-engine alias (null = local) for each entity the engines have surfaced. */
	origins(): Promise<Record<string, string | null>>;
	/** Connect the box if needed, then clone+register a repo ON it from its remote URL
	 *  (so a task can run there). Returns the box's project row for that repo. */
	provision(alias: string, input: { cloneUrl: string }): Promise<ProjectDTO>;
	/** Install the ateam engine on a fresh box over SSH (idempotent; sets up the
	 *  phone's WebSocket listener too), then connect. `dest` is an ssh_config alias
	 *  or `user@host`. Progress streams via onInstallLog. */
	install(dest: string, opts?: { wsAddr?: string }): Promise<HostStatus>;
	/** Fires with the full connected set whenever an engine is added or removed. */
	onConnectionsChanged(cb: (connected: HostStatus[]) => void): () => void;
	/** Subscribe to installer output during install(); returns an unsubscribe. */
	onInstallLog(cb: (e: InstallLogEvent) => void): () => void;
}
