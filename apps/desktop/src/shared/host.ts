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
	/** Create a box from scratch at a cloud provider, provision it, and connect. */
	createBox: "host:createBox",
	/** Install an agent's CLI on a connected box (streamed via evtInstallLog). */
	installAgent: "host:installAgent",
	/** Read/write the encrypted provider credentials (token + Tailscale auth key). */
	secretsStatus: "host:secretsStatus",
	saveSecrets: "host:saveSecrets",
	/** The provider's live catalog (regions + sizes) for the given/saved token. */
	providerOptions: "host:providerOptions",
	evtConnectionsChanged: "evt:host:connections",
	/** Streamed installer output (stdout+stderr) during host:install. */
	evtInstallLog: "evt:host:install-log",
	/** Staged progress while creating a box (host:createBox). */
	evtCreateProgress: "evt:host:create-progress",
} as const;

/** One chunk of installer output, tagged with the destination it came from. */
export interface InstallLogEvent {
	/** The SSH destination being set up (ssh_config alias or user@host). */
	dest: string;
	chunk: string;
}

/** What to create at the provider. Credentials fall back to the saved secrets. */
export interface CreateBoxSpec {
	/** Box name → ssh_config alias + Tailscale hostname (sanitized to a DNS label). */
	name: string;
	/** Provider location slug (e.g. Hetzner `fsn1`). */
	region: string;
	/** Provider server-type slug (e.g. Hetzner `cx22`). */
	size: string;
	/** Overrides the saved Hetzner token for this run (and is then remembered). */
	hetznerToken?: string;
	/** Overrides the saved Tailscale auth key for this run (and is then remembered). */
	tailscaleAuthKey?: string;
	/** Agent CLIs to preinstall on the box after the engine (by id, e.g. "claude"). */
	agents?: string[];
}

/** Result of installing an agent's CLI on a box — the login the user runs next. */
export interface InstallAgentResult {
	agentId: string;
	/** The OAuth login to run on the box to finish setup (undefined if none needed). */
	loginCommand?: string;
}

/** A stage narration while a box is being created (no secrets, just the step). */
export interface CreateProgressEvent {
	alias: string;
	stage: string;
}

/** Whether each provisioning secret is already saved (never the value itself). */
export interface SecretsStatus {
	hetznerToken: boolean;
	tailscaleAuthKey: boolean;
}

/** The provider's live catalog, fetched with the token so it reflects real availability. */
export interface ProviderOptions {
	locations: { slug: string; label: string }[];
	/** `locations` = the slugs a size is available in (empty = unknown → offer anywhere). */
	serverTypes: { slug: string; label: string; locations: string[] }[];
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
	/** Create a box from scratch at a cloud provider (generates the SSH key, joins
	 *  Tailscale, installs the engine), then connect. Progress via onCreateProgress +
	 *  onInstallLog; credentials fall back to the saved secrets. */
	createBox(spec: CreateBoxSpec): Promise<HostStatus>;
	/** Install an agent's CLI on a connected box (streamed via onInstallLog), then
	 *  return the one-time OAuth login to run on the box. */
	installAgent(alias: string, agentId: string): Promise<InstallAgentResult>;
	/** Which provisioning secrets are already saved (booleans, never the values). */
	secretsStatus(): Promise<SecretsStatus>;
	/** Persist provider credentials (encrypted at rest). Empty string clears one. */
	saveSecrets(patch: { hetznerToken?: string; tailscaleAuthKey?: string }): Promise<SecretsStatus>;
	/** The provider's real regions + sizes for the given token (or the saved one). */
	providerOptions(token?: string): Promise<ProviderOptions>;
	/** Fires with the full connected set whenever an engine is added or removed. */
	onConnectionsChanged(cb: (connected: HostStatus[]) => void): () => void;
	/** Subscribe to installer output during install()/createBox(); returns an unsubscribe. */
	onInstallLog(cb: (e: InstallLogEvent) => void): () => void;
	/** Subscribe to box-creation stage narration; returns an unsubscribe. */
	onCreateProgress(cb: (e: CreateProgressEvent) => void): () => void;
}
