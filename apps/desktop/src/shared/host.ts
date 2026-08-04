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
	evtConnectionsChanged: "evt:host:connections",
} as const;

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
	/** Fires with the full connected set whenever an engine is added or removed. */
	onConnectionsChanged(cb: (connected: HostStatus[]) => void): () => void;
}
