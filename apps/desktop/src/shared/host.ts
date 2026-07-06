// The desktop's connection-control contract: which engine drives the app. This
// is renderer↔main IPC *about choosing an engine* — deliberately separate from
// window.ateam (the engine surface itself), mirroring how @ateam/server keeps
// connection management off AteamApi. Imports only @ateam/protocol (dependency-
// free), so both the node (main/preload) and web (renderer) tsconfigs resolve it.
import type { ConnectionDTO, SystemInfo } from "@ateam/protocol";

/** Renderer↔main channels for listing/choosing/observing the active engine. */
export const HOST_CH = {
	list: "host:list",
	connect: "host:connect",
	current: "host:current",
	evtChanged: "evt:host:changed",
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
 * window.ateamHost — the connection-control surface. `connect(null)` switches back
 * to the local in-process engine; `connect(alias)` drives the engine on that
 * ssh_config host over SSH. Distinct from window.ateam, which is whichever engine
 * is currently active.
 */
export interface AteamHost {
	list(): Promise<ConnectionDTO[]>;
	connect(alias: string | null): Promise<HostStatus>;
	current(): Promise<HostStatus>;
	onChanged(cb: (status: HostStatus) => void): () => void;
}
