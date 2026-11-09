// The desktop's connection-control contract: which engine drives the app. This
// is renderer↔main IPC *about choosing an engine* — deliberately separate from
// window.ateam (the engine surface itself), mirroring how @ateam/server keeps
// connection management off AteamApi. Imports only @ateam/protocol (dependency-
// free), so both the node (main/preload) and web (renderer) tsconfigs resolve it.
import type {
	BoxLinkDTO,
	BoxWake,
	ConnectionDTO,
	ConnectStep,
	DotfilesConfig,
	DotfilesPlan,
	DotfilesStatus,
	GithubAccessDTO,
	PairingInviteDTO,
	PairingStatusDTO,
	ProjectDTO,
	RepoAccessDTO,
	SystemInfo,
} from "@ateam/protocol";

/** One grammar issue as the judge needs it (mirrors @ateam/server's GrammarJudgeIssue). */
export interface GrammarJudgeIssue {
	start: number;
	end: number;
	problem: string;
	message: string;
	suggestions: string[];
}

/** Renderer↔main channels for listing/choosing/observing the connected engines. */
export const HOST_CH = {
	list: "host:list",
	connect: "host:connect",
	disconnect: "host:disconnect",
	/** Remove a box from the connections list (disconnecting it first if held). */
	forget: "host:forget",
	/** All currently-held engines (local is always present). */
	connected: "host:connected",
	/** projectId/taskId → owning engine alias (null = local), for per-origin badges/routing. */
	origins: "host:origins",
	/** alias → why the last automatic connect attempt failed (see AteamHost.failures). */
	failures: "host:failures",
	/** Whether this build can upgrade a box at all (see AteamHost.canUpdateBoxes). */
	canUpdateBoxes: "host:canUpdateBoxes",
	/** This app's release ("0.1.80"), to compare a box's engine with. */
	appRelease: "host:appRelease",
	/** The GitHub access each box last reported (Host.githubStatuses). */
	boxGithub: "host:boxGithub",
	/** A held box's lock and paired devices (pairing:*, v29). */
	pairingStatus: "host:pairingStatus",
	pairingInvite: "host:pairingInvite",
	pairingRevoke: "host:pairingRevoke",
	pairingLock: "host:pairingLock",
	/** Every held box in one QR for Ateam Go (Settings → Boxes → Pair your iPhone). */
	phonePairing: "host:phonePairing",
	crossBoxStatus: "host:crossBoxStatus",
	crossBoxSet: "host:crossBoxSet",
	/** Clone+register a repo onto a specific box (connect it first). */
	provision: "host:provision",
	/** Install the ateam engine on a reachable SSH box, then connect to it. */
	install: "host:install",
	/** Create a box from scratch at a cloud provider, provision it, and connect. */
	createBox: "host:createBox",
	/** Install an agent's CLI on a connected box (streamed via evtInstallLog). */
	installAgent: "host:installAgent",
	/** Probe a connected box's task-readiness (gh installed/signed-in, git identity). */
	boxReadiness: "host:boxReadiness",
	/** Update a box's engine (SSH install, or the engine's own update over Tailscale). */
	updateBox: "host:updateBox",
	/** Join a box reached over SSH to the tailnet and open its network port there. */
	phoneAccess: "host:phoneAccess",
	/** Keep a connected box always on, or let it sleep when idle (box.alwaysOn there). */
	boxAlwaysOn: "host:boxAlwaysOn",
	/** Explicit dotfiles operations on a named box. */
	dotfilesStatus: "host:dotfilesStatus",
	prepareDotfiles: "host:prepareDotfiles",
	applyDotfiles: "host:applyDotfiles",
	/** A connected box's GitHub access, handing it a token, and its per-repo access. */
	githubAccess: "host:githubAccess",
	connectGithub: "host:connectGithub",
	checkGithub: "host:checkGithub",
	/** Open a github.com page in the user's own browser. */
	openGithub: "host:openGithub",
	/** Open Hetzner's or Tailscale's console, where Create a box's token and key come from. */
	openConsole: "host:openConsole",
	/** Read/write the encrypted provider credentials (token + Tailscale auth key). */
	secretsStatus: "host:secretsStatus",
	saveSecrets: "host:saveSecrets",
	/** The provider's live catalog (regions + sizes) for the given/saved token. */
	providerOptions: "host:providerOptions",
	/** Which wake providers have a key saved on this Mac (see AteamHost.wakeStatus). */
	wakeStatus: "host:wakeStatus",
	/** Check and save, or clear, one wake provider's key (encrypted). */
	saveWakeAccount: "host:saveWakeAccount",
	/** Which of the grammar check's issues to show (see AteamHost.judgeGrammar). */
	judgeGrammar: "host:judgeGrammar",
	evtConnectionsChanged: "evt:host:connections",
	/** A box's GitHub access changed (Host.githubStatuses): only what reads it listens. */
	evtGithubChanged: "evt:host:github",
	/** Streamed installer output (stdout+stderr) during host:install. */
	evtInstallLog: "evt:host:install-log",
	/** Staged progress while creating a box (host:createBox). */
	evtCreateProgress: "evt:host:create-progress",
	/** The steps of waking and reaching a box (see ConnectProgressEvent). */
	evtConnectProgress: "evt:host:connect-progress",
} as const;

/** The page Tailscale prints for approving a device that joins without an auth key
 *  (`tailscale up`), as it appears in installer output: followed by whitespace once
 *  the whole link has arrived. */
export const TAILSCALE_LOGIN_URL = /https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]+(?=\s)/;

/** How a box update went: installed over SSH, or started by the box's own engine. */
export type BoxUpdateResult = { via: "ssh" } | { via: "self"; started: boolean; logPath: string };

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

/** A connected box's task-readiness — what a task needs beyond the engine. */
export interface BoxReadiness {
	/** GitHub CLI: installed on the box, and signed in (so it can clone private repos). */
	gh: { installed: boolean; signedIn: boolean; login?: string };
	/** The git commit identity (derived from the GitHub login once signed in). */
	gitName?: string;
	gitEmail?: string;
	/** When the box's Tailscale key expires (ISO), for a box approved from a link; a
	 *  tagged box, or one whose expiry is turned off, has none. */
	tailscaleKeyExpiry?: string;
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

/** The steps of waking and reaching a box a provider puts to sleep. Empty `steps`
 *  means the attempt is over and succeeded; a failed one keeps its failed step. */
export interface ConnectProgressEvent {
	alias: string;
	steps: ConnectStep[];
}

/** Provider id → whether its key is saved on this Mac (never the key itself). */
export type WakeStatus = Record<string, boolean>;

/** How a connect treats a box's provider. */
export interface ConnectOptions {
	/** Wake the box through its provider first. Only a user's action asks for this:
	 *  waking costs money, so opening the app never does. */
	wake?: boolean;
	/** Set (or with null, clear) which provider wakes this `host:port` box. Saved
	 *  once the box answers, like the box itself. */
	binding?: BoxWake | null;
	/** A one-time pairing code for a locked box (v29): redeemed on this connect,
	 *  and this Mac keeps the device token it gives. */
	code?: string;
}

/** Whether each provisioning secret is already saved (never the value itself). */
/** Pair your iPhone: one `ateamgo://pair` link for every box this Mac holds. */
export interface PhonePairing {
	/** Null when the phone can reach none of them. */
	link: string | null;
	/** When the first of its codes runs out; null when it holds none. */
	expiresAt: number | null;
	/** Each held box, and how it goes on the phone (or why it doesn't). Boxes this
	 *  Mac isn't connected to now aren't here. */
	boxes: PhonePairingBox[];
}

export interface PhonePairingBox {
	alias: string;
	/** locked: in the link with a code. open: in it by its address alone. noPort:
	 *  the phone can't reach it. failed: the box didn't answer (`error` says how). */
	state: "locked" | "open" | "noPort" | "failed";
	error?: string;
}

export interface SecretsStatus {
	hetznerToken: boolean;
	tailscaleAuthKey: boolean;
}

/** The provider's live catalog, fetched with the token so it reflects real availability. */
export interface ProviderOptions {
	locations: { slug: string; label: string }[];
	/** `locations` = the slugs a size can be ordered in (empty = unknown → offer anywhere). */
	serverTypes: { slug: string; label: string; locations: string[]; memory: number }[];
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
/** Cross-box as Settings → Boxes shows it: the switch, and each held box's links. */
export interface CrossBoxStatusDTO {
	on: boolean;
	boxes: {
		alias: string;
		/** Why it is left out, or why other boxes can't reach it. */
		problem?: string;
		links: BoxLinkDTO[];
	}[];
}

export interface AteamHost {
	list(): Promise<ConnectionDTO[]>;
	/** Add an engine (idempotent if already held). `null` is a no-op — local is permanent. */
	connect(alias: string | null, opts?: ConnectOptions): Promise<HostStatus>;
	/** Drop a connected box (never local). */
	disconnect(alias: string): Promise<void>;
	/** Remove a box from the connections list (disconnecting it first if held).
	 *  Setting it up or connecting to it again brings it back; ~/.ssh/config is
	 *  never edited. */
	forget(alias: string): Promise<void>;
	/** Every engine currently held (local first). */
	connected(): Promise<HostStatus[]>;
	/** id → owning-engine alias (null = local) for each entity the engines have surfaced. */
	origins(): Promise<Record<string, string | null>>;
	/**
	 * alias → the message from the last connect this app made on its OWN initiative
	 * (the startup sweep). Those failures have no caller to reject to, so without
	 * this a box that failed to come up is indistinguishable from one that is merely
	 * asleep. A successful connect clears the entry.
	 */
	failures(): Promise<Record<string, string>>;
	/**
	 * Whether this build can bring a box up to its own version.
	 *
	 * Only a packaged build can. install.sh serves RELEASES, so an upgrade lands on
	 * whatever the newest release holds; a packaged build pins ATEAM_VERSION to its
	 * own tag and therefore gets exactly the protocol it speaks, while a dev build
	 * runs main, whose protocol is ahead of any release the moment it is bumped. An
	 * update offered from dev would run for a minute and change nothing, so the UI
	 * asks this before offering one. Same invariant as the auto-heal in connect().
	 */
	canUpdateBoxes(): Promise<boolean>;
	/** This app's release ("0.1.80"): what a box's engine is compared with (SystemInfo.release). */
	appRelease(): Promise<string>;
	/** The GitHub access each box last reported, by alias, without reaching a box. */
	boxGithub(): Promise<Record<string, GithubAccessDTO>>;
	/** Whether a held box (v29) is locked to its paired devices, and which they are. */
	pairingStatus(alias: string): Promise<PairingStatusDTO>;
	/** A one-time code for another device, with the `ateamgo://` link a phone's
	 *  Camera opens when the box is reached by address (null for an SSH alias). */
	pairingInvite(alias: string): Promise<PairingInviteDTO & { link: string | null }>;
	/** Unpair a device: its token stops working and its connections drop. */
	pairingRevoke(alias: string, id: string): Promise<PairingStatusDTO>;
	/** Lock an open box to the devices paired with it, starting with this Mac. */
	pairingLock(alias: string): Promise<PairingStatusDTO>;
	/** The QR that puts every box this Mac holds on a phone: a fresh code for each
	 *  locked one, the address alone for an open one. */
	phonePairing(): Promise<PhonePairing>;
	/** Whether the boxes reach each other (cross-box, v30), and how each one's
	 *  links are doing. */
	crossBoxStatus(): Promise<CrossBoxStatusDTO>;
	/** Turn cross-box on or off: links are set up, or taken down, on every box. */
	crossBoxSet(on: boolean): Promise<CrossBoxStatusDTO>;
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
	/** Probe a connected box's task-readiness (also derives the git identity once the
	 *  box is signed into GitHub). */
	boxReadiness(alias: string): Promise<BoxReadiness>;
	/** Bring a box's engine up to date. Over SSH it finishes when the box is back on
	 *  this app's release; a Tailscale box updates itself and reconnects shortly. */
	updateBox(alias: string): Promise<BoxUpdateResult>;
	/** Make a box reached over SSH reachable from Ateam Go: the installer again, with
	 *  --tailscale, so it joins the tailnet and opens the box's network port there.
	 *  Tailscale's page to approve the box opens in the browser, and its link is in
	 *  the installer output (onInstallLog, TAILSCALE_LOGIN_URL). Resolves once the
	 *  box is connected again. */
	phoneAccess(alias: string): Promise<HostStatus>;
	/** Keep a connected box always on (true) or let it sleep when idle (false), on the
	 *  box itself; answers whether it sleeps now, which a Mac's idle window of "never"
	 *  can keep false either way. */
	setBoxAlwaysOn(alias: string, on: boolean): Promise<{ sleeps: boolean | null }>;
	/** Explicit dotfiles preview/apply on the named connected box (v35). */
	dotfilesStatus(alias: string): Promise<DotfilesStatus>;
	prepareDotfiles(alias: string, config: DotfilesConfig): Promise<DotfilesPlan>;
	applyDotfiles(alias: string, planId: string): Promise<DotfilesStatus>;
	/** A connected box's GitHub access: what its gh and git sign in with. */
	githubAccess(alias: string): Promise<GithubAccessDTO>;
	/** Hand a connected box a GitHub token; answers its new access. Rejects with a
	 *  sentence the user can act on (a bad paste, a refused token). */
	connectGithub(alias: string, token: string): Promise<GithubAccessDTO>;
	/** Per repo (`owner/name`), whether a connected box can push, only read, or not see
	 *  it. None given = the box's own projects. */
	checkGithub(alias: string, repos?: string[]): Promise<RepoAccessDTO[]>;
	/** Open a github.com page in the user's own browser, where they're signed in. */
	openGithub(url: string): Promise<void>;
	/** Open a page of Hetzner's or Tailscale's console in the user's own browser. */
	openConsole(url: string): Promise<void>;
	/** Which provisioning secrets are already saved (booleans, never the values). */
	secretsStatus(): Promise<SecretsStatus>;
	/** Persist provider credentials (encrypted at rest). Empty string clears one. */
	saveSecrets(patch: { hetznerToken?: string; tailscaleAuthKey?: string }): Promise<SecretsStatus>;
	/** The provider's real regions + sizes for the given token (or the saved one). */
	providerOptions(token?: string): Promise<ProviderOptions>;
	/** Which wake providers have a key saved on this Mac. */
	wakeStatus(): Promise<WakeStatus>;
	/** Check `values` with the provider and save them (encrypted), or clear them
	 *  with null. Rejects with the provider's answer when the key doesn't work. */
	saveWakeAccount(providerId: string, values: Record<string, string> | null): Promise<WakeStatus>;
	/**
	 * Per issue, whether to show it, decided by this Mac's decision model (Jev
	 * on OpenRouter or Luna on OpenAI) with its key (never sent to the
	 * renderer). Null when it won't or couldn't decide: no key, the decision
	 * model off, `client.filterGrammarWithJev` off, or no answer in time. The
	 * renderer then shows every issue.
	 */
	judgeGrammar(draft: string, issues: GrammarJudgeIssue[]): Promise<boolean[] | null>;
	/** Fires with the full connected set whenever an engine is added or removed. */
	onConnectionsChanged(cb: (connected: HostStatus[]) => void): () => void;
	/** Fires when a box's GitHub access changes (boxGithub), not on every read of it. */
	onGithubChanged(cb: () => void): () => void;
	/** Subscribe to installer output during install()/createBox(); returns an unsubscribe. */
	onInstallLog(cb: (e: InstallLogEvent) => void): () => void;
	/** Subscribe to box-creation stage narration; returns an unsubscribe. */
	onCreateProgress(cb: (e: CreateProgressEvent) => void): () => void;
	/** Subscribe to the steps of waking and reaching a box; returns an unsubscribe. */
	onConnectProgress(cb: (e: ConnectProgressEvent) => void): () => void;
}
