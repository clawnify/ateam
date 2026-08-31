// The Ateam wire contract: plain DTOs, channel names, event payloads, and the
// AteamApi surface. Dependency-free by design so every consumer — the desktop
// renderer, the Electron main process, and the (future) headless @ateam/server
// over SSH — shares one definition without pulling in node/electron/db internals.

/**
 * Wire-contract version. A client checks it on connect (via `system:hello`) and
 * refuses/warns on mismatch, so a version-skewed remote fails cleanly at the
 * handshake instead of cryptically mid-call ("Unknown method"/corrupt shape).
 * BUMP THIS on any breaking change to CH methods, their args, or DTO shapes.
 * Monotonic integer — deliberately not the npm version (workspaces are 0.0.0 and
 * the daemon is bundled, so package.json is neither meaningful nor readable here).
 */
// v2 (0.1.32): added CH.projectsClone + CH.projectsRemoteUrl. Additive on the wire,
// but the skew that actually happens is NEW CLIENT → OLD SERVER — the desktop
// auto-updates, a box only changes when someone re-runs the installer. Without the
// bump those clients pass the handshake and then fail deep in a feature with a raw
// `Unknown method: projects:clone`; with it they get "update the older side" up front.
// v3: Loops pivot — user-created agent-session loops only + CH.loopsUpdate (edit a
// loop in place). Same skew rationale as v2.
// v4: added CH.searchSessions. Same reasoning again — a new desktop searching an
// older box would otherwise get `Unknown method: search:sessions` from the search
// box instead of "update the older side".
// v5: TaskDTO gained a required `triage` verdict (with the `stalled` bucket) and a
// `tags` field, and CH.tasksMarkRead was added. Same skew again — an old engine
// sends cards with no `triage`, which the board reads on EVERY card, and answers
// markRead with "Unknown method".
// v6: TaskDTO gained `prState`, and CleanupCandidate now carries a whole TaskDTO
// plus a `recommended` flag (it used to be a flat, pre-filtered row). Both are
// shape changes the cleanup dialog reads directly, so an older engine would feed
// it rows with no `task` at all — the handshake must catch that skew first.
// v7: added CH.systemUpdate, so a box can be told to update ITSELF. The phone has
// no SSH and pty:spawnShell needs a taskId, so before this there was no way to fix
// a skewed box from the phone at all. Note what this version can and cannot do: a
// box older than v7 has no such method, so it still takes one update over SSH (or
// by hand) before the phone can ever drive the next one. That bootstrap is not
// avoidable from the client side.
//
// From v7 the mismatch is ADVISORY rather than a refusal: clients hold a skewed
// box, read it through tolerantRpc, and say so in the UI. The bump rule below is
// unchanged, but the reason to obey it shifts: a bump no longer locks old clients
// out, it tells them what to paper over.
export const PROTOCOL_VERSION = 7;

export type KanbanColumn = "todo" | "running" | "needs_attention" | "review" | "merged";

export type AgentStatus = "idle" | "running" | "awaiting_input" | "stopped";

/** State of the branch's pull request, when one exists. */
export type PrState = "open" | "merged" | "closed";

/**
 * Why a task is where it is, in urgency order — the done-vs-ongoing judgment
 * from worktree-triage. Lives here (not in @ateam/server) because it rides on
 * every TaskDTO: the classifier is server-side, but desktop, mobile, and any
 * client on the far end of the RPC all render it.
 */
export type TriageBucket =
	| "active"
	| "stalled"
	| "uncommitted"
	| "open_pr"
	| "unmerged_no_pr"
	| "merged_unfinished"
	| "merged_done"
	| "orphan"
	| "not_started";

/** One task's triage verdict, computed from its row on every DTO mapping. */
export interface TaskTriage {
	bucket: TriageBucket;
	/** Is this task actually finished? */
	done: boolean;
	/** Human-readable justification, shown on the card. */
	reason: string;
}

/** Position of a task in the merge queue; null when not queued. */
export type MergeStatus = "queued" | "updating" | "merging" | "conflict";

export interface ProjectDTO {
	id: string;
	repoPath: string;
	name: string;
	defaultBranch: string | null;
	githubOwner: string | null;
	githubName: string | null;
	color: string | null;
}

export interface GitStatusSnapshot {
	ahead: number;
	behind: number;
	dirty: number;
	updatedAt: number;
}

export interface TaskDTO {
	id: string;
	projectId: string;
	name: string;
	description: string | null;
	slug: string;
	branch: string;
	baseBranch: string;
	worktreePath: string;
	column: KanbanColumn;
	agentStatus: AgentStatus | null;
	agentId: string | null;
	/** Merge-queue position; null when the task is not queued to merge. */
	mergeStatus: MergeStatus | null;
	prNumber: number | null;
	prUrl: string | null;
	/** open / merged / closed, or null when the branch has no PR. */
	prState: PrState | null;
	gitStatus: GitStatusSnapshot | null;
	/** Last agent/lifecycle activity (falls back to row update time). */
	lastEventAt: number | null;
	isUnread: boolean;
	/** Model-assigned topic tags; null when none were generated (the client
	 *  falls back to deriving them from the task's text). */
	tags: string[] | null;
	/** Done-vs-ongoing verdict, derived from this row (no git/gh calls). */
	triage: TaskTriage;
}

export interface AgentDTO {
	id: string;
	label: string;
	description: string;
	available: boolean;
}

export interface SessionDTO {
	id: string;
	taskId: string;
	agentId: string;
	terminalId: string;
	status: AgentStatus;
	cwd: string;
}

export interface DiffFileDTO {
	path: string;
	additions: number;
	deletions: number;
	binary: boolean;
	untracked: boolean;
}

export interface DiffResultDTO {
	baseBranch: string | null;
	files: DiffFileDTO[];
}

export interface UpdateResultDTO {
	status: "clean" | "conflicts";
	conflicts: string[];
}

export interface MergeResultDTO {
	prNumber: number | null;
	prUrl: string | null;
	localMainUpdated: boolean;
	localMainStrategy: "direct-ref" | "ff-worktree" | "skipped";
	reason?: string;
}

export type MergeStrategy = "merge" | "squash" | "rebase";

/**
 * Result of enqueuing a merge. The merge runs serialized per base branch, so
 * the call resolves only once this task's turn completes (or it parks on a
 * genuine conflict / busy / error).
 */
export type MergeEnqueueDTO =
	| { ok: true; prNumber: number | null; prUrl: string | null }
	| { ok: false; reason: "conflict"; conflicts: string[] }
	| { ok: false; reason: "busy" }
	| { ok: false; reason: "error"; message: string };

/** A Loop (periodic reconciler) as shown in the Loops panel. */
export interface LoopDTO {
	id: string;
	definitionId: string;
	title: string;
	description: string;
	scope: "global" | "per_task";
	scopeKey: string | null;
	/** "builtin" loops are code-defined; "user" loops are template instances. */
	kind: "builtin" | "user";
	templateId: string | null;
	projectId: string | null;
	enabled: boolean;
	cadence: "fixed" | "self_paced";
	/** The prompt each run hands the agent (agent-session loops). */
	prompt: string | null;
	/** Which coding agent each run launches (agent-session loops). */
	agentId: string | null;
	/** The loop's one persistent task — every run is a fresh session in it. */
	taskId: string | null;
	intervalMs: number | null;
	lastRunAt: number | null;
	nextRunAt: number | null;
	lastStatus: "ok" | "error" | "done" | null;
	lastSummary: string | null;
	lastError: string | null;
	runs: number;
}

/** A loop template the user can instantiate, with its configurable params. */
export interface LoopTemplateParamDTO {
	key: string;
	label: string;
	type: "number" | "boolean" | "string";
	default: number | boolean | string;
	help?: string;
}
export interface LoopTemplateDTO {
	id: string;
	title: string;
	description: string;
	params: LoopTemplateParamDTO[];
}

/** Input for creating a user loop from a template. */
export interface CreateLoopInput {
	templateId: string;
	name: string;
	projectId?: string;
	config?: Record<string, unknown>;
	intervalMs?: number;
	enabled?: boolean;
}

/**
 * Input for editing an existing user loop in place. Only the given fields
 * change; `config` is merged over the stored config (so runtime keys like
 * lastTaskId survive). The loop's project — and with it its environment — is
 * fixed at creation: moving engines means delete + recreate. No projectId here
 * also keeps the aggregate routing this call by the loop's own id.
 */
export interface UpdateLoopInput {
	id: string;
	name?: string;
	intervalMs?: number;
	config?: Record<string, unknown>;
}

export interface CleanupItem {
	id: string;
	name: string;
	branch: string;
}
export interface CleanupSkip extends CleanupItem {
	reason: string;
}
export interface CleanupReport {
	removed: CleanupItem[];
	kept: CleanupSkip[];
}

/**
 * The connect-time handshake reply (`system:hello`): the engine's protocol
 * version for the compatibility check, and which agents its box actually has.
 */
export interface SystemInfo {
	protocolVersion: number;
	/** Ids of agents installed + available on the engine's machine. */
	agents: string[];
}

/** What `system:update` reports back before the engine goes down to be replaced. */
export interface BoxUpdateStarted {
	/** False when an update was already running: the caller double-tapped, or another
	 *  client got there first. Nothing new was launched. */
	started: boolean;
	/** Where the installer's output is going on the box, so a human can read why it
	 *  failed after the fact. The engine that could have streamed it is the thing
	 *  being replaced, so a file is the only place that survives the restart. */
	logPath: string;
}

// A subdirectory in a remote-fs listing (the repo picker over RPC).
export interface DirEntryDTO {
	name: string;
	/** Absolute path on the engine's machine. */
	path: string;
	/** True when the directory holds a `.git` (a git repo root). */
	isRepo: boolean;
}
/** One directory's worth of subdirectories, for navigating the engine's fs. */
export interface DirListingDTO {
	/** The resolved absolute directory that was listed. */
	path: string;
	/** Its parent directory, or null at the filesystem root. */
	parent: string | null;
	/** Subdirectories, sorted by name. */
	entries: DirEntryDTO[];
}

/**
 * A row in the connections list: an ssh_config alias enriched with Ateam's own
 * last-known metadata for that host. Rendered by the client's connection picker;
 * produced by `@ateam/server`'s `listConnections`. A boundary DTO (server writes,
 * renderer reads), so it lives here rather than in the server package — the
 * ssh_config parse-shape (`SshHost`) and write-shape (`ConnectionRecord`) stay
 * server-internal.
 */
/**
 * How a client opens a connection to a box.
 *
 *   ssh  spawn `ssh <alias> ateam attach --stdio` — OpenSSH owns auth, and the
 *        alias resolves in ~/.ssh/config. The default, and what a box exposes
 *        with no extra listener.
 *   ws   a WebSocket to the box's opt-in listener on its Tailscale address. The
 *        socket carries no auth of its own — the tailnet is the boundary — so it
 *        requires a Tailscale ACL scoping who may reach the port.
 */
export type HostTransport = "ssh" | "ws";

export interface ConnectionDTO {
	/** For `ssh`, the ~/.ssh/config alias. For `ws`, the `host:port` endpoint itself. */
	alias: string;
	transport: HostTransport;
	hostName: string | null;
	serverVersion: string | null;
	agentsAvailable: string[] | null;
	lastSeen: number | null;
	/** Present in ~/.ssh/config right now (vs a saved record since removed from it). */
	inSshConfig: boolean;
	/** We've recorded at least one successful connection (has a saved record). */
	known: boolean;
}

/**
 * One worktree in the cleanup dialog. EVERY task in the project is listed —
 * the old rule (merged + no live session + clean tree) no longer filters the
 * list, it only advises through `recommended`, so the call stays with the user
 * and is made on the factors the whole task carries: last activity, PR state,
 * ahead/dirty counts, triage verdict.
 */
export interface CleanupCandidate {
	/** The task itself, so the dialog can show every deciding factor. */
	task: TaskDTO;
	/** A live PTY session to show/continue, or null if the session ended. */
	terminalId: string | null;
	/** The conservative rule's verdict: safe to sweep. */
	recommended: boolean;
	/** Why it is — or is not — recommended. */
	reason: string;
}

/**
 * One hit from session search: a past agent session that matched, joined back
 * to the task it ran in. `terminalId` is present only when that session's tab
 * is still live, which is what decides whether a click can focus the exact
 * terminal or only open the task.
 */
export interface SessionHitDTO {
	/** The harness's own session id — the handle its resume command takes. */
	sessionId: string;
	agentId: string;
	taskId: string;
	taskName: string;
	branch: string | null;
	terminalId: string | null;
	startedAt: number | null;
	endedAt: number | null;
	/** The user's own words from the matching part of the session. */
	excerpt: string;
	/** The model's one-line reason, when the AI pass ran. */
	why: string | null;
}

// ---- IPC channel names ----
export const CH = {
	projectsPick: "projects:pick",
	projectsRegister: "projects:register",
	projectsClone: "projects:clone",
	projectsRemoteUrl: "projects:remoteUrl",
	projectsList: "projects:list",
	projectsRemove: "projects:remove",
	windowOpenProject: "window:openProject",
	tasksList: "tasks:list",
	tasksCreate: "tasks:create",
	tasksRemove: "tasks:remove",
	tasksSetColumn: "tasks:setColumn",
	tasksMarkRead: "tasks:markRead",
	tasksCleanup: "tasks:cleanup",
	tasksCleanupPreview: "tasks:cleanupPreview",
	tasksCleanupCandidates: "tasks:cleanupCandidates",
	gitCommit: "git:commit",
	gitPush: "git:push",
	gitUpdate: "git:update",
	gitMerge: "git:merge",
	gitDiff: "git:diff",
	gitFileDiff: "git:fileDiff",
	gitStatus: "git:status",
	loopsList: "loops:list",
	loopsSetEnabled: "loops:setEnabled",
	loopsRunNow: "loops:runNow",
	loopsTemplates: "loops:templates",
	loopsCreate: "loops:create",
	loopsUpdate: "loops:update",
	loopsDelete: "loops:delete",
	agentsList: "agents:list",
	searchSessions: "search:sessions",
	systemHello: "system:hello",
	systemUpdate: "system:update",
	fsListDir: "fs:listDir",
	utilPickFiles: "util:pickFiles",
	utilAttachImages: "util:attachImages",
	utilAttachClipboardImage: "util:attachClipboardImage",
	utilWriteImageBytes: "util:writeImageBytes",
	utilOpenInEditor: "util:openInEditor",
	editorOpen: "editor:open",
	editorOpenUrl: "editor:openUrl",
	editorInstall: "editor:install",
	ptySpawnAgent: "pty:spawnAgent",
	ptySpawnShell: "pty:spawnShell",
	ptyWrite: "pty:write",
	ptyResize: "pty:resize",
	ptyKill: "pty:kill",
	ptySnapshot: "pty:snapshot",
	ptyListForTask: "pty:listForTask",
	// main → renderer push events
	evtPtyData: "evt:pty:data",
	evtPtyExit: "evt:pty:exit",
	evtTaskUpdated: "evt:task:updated",
	evtTaskRemoved: "evt:task:removed",
	evtLoopsUpdated: "evt:loops:updated",
} as const;

// ---- event payloads ----
export interface PtyDataEvent {
	terminalId: string;
	data: string;
	/**
	 * Monotonic per-session sequence number for this chunk. The snapshot reply
	 * carries the seq of the last chunk it already includes, so a freshly-mounted
	 * view can replay the snapshot first and then apply only the live chunks that
	 * came *after* it — never double-applying bytes the snapshot already has.
	 */
	seq: number;
}
/** A serialized terminal state plus the seq of the last chunk it reflects. */
export interface PtySnapshot {
	data: string;
	seq: number;
}
export interface PtyExitEvent {
	terminalId: string;
	exitCode: number;
}

/**
 * How the host delivered an image attach (utils.attachImages / attachClipboardImage):
 * "ctrlv" — a bitmap is staged on the client clipboard; forward a Ctrl+V so the
 * local agent reads the pixels itself. "paths" — TYPE these paths into the PTY
 * (escaped keystrokes, not a paste) so the agent's typed-path detection attaches
 * them; for a remote agent they are box-side temp files. "none" — nothing to do
 * (cancelled picker, empty clipboard, or no file survived the transfer).
 */
export type AttachDelivery =
	| { mode: "ctrlv" }
	| { mode: "paths"; paths: string[] }
	| { mode: "none" };

/**
 * Outcome of handing a worktree to the user's own editor. `ok: false` carries a
 * reason to show — the editor isn't installed, or the task's engine is reached by
 * a `host:port` endpoint that Remote-SSH can't resolve.
 */
export type OpenInEditorResult = { ok: true } | { ok: false; reason: string };

/**
 * The in-app editor's default port on the engine's machine (code-server). Shared
 * between the engine (which binds it) and the desktop's SSH forward (which is
 * opened at connect time, before the engine is asked) — so both sides must agree.
 * shortcut: a box overriding ATEAM_EDITOR_PORT breaks the ssh path; carry the
 * port in system:hello if that override ever matters.
 */
export const DEFAULT_EDITOR_PORT = 8390;

/** Where the engine's embedded editor (code-server) answers, on ITS machine. */
export interface EditorEndpointDTO {
	port: number;
}

/**
 * editor:open's answer: the endpoint, or "code-server isn't installed here" —
 * a state, not an error, so clients can front the install with a consent dialog
 * instead of parsing an exception.
 */
export type EditorOpenResult = EditorEndpointDTO | { needsInstall: true };

// ---- the API surface exposed on window.ateam ----
export interface AteamApi {
	projects: {
		pick(): Promise<string | null>;
		/** `init: true` runs `git init` + initial commit first (after asking). */
		register(repoPath: string, opts?: { init?: boolean }): Promise<ProjectDTO>;
		// NB: projects:clone (CH.projectsClone) is deliberately NOT on this surface —
		// it must target a specific box, so it's driven by ateamHost.provision →
		// backend.handle(CH.projectsClone) directly, never the id-routed aggregate.
		/** The project's `origin` remote URL, or null if local-only. Decides whether a
		 *  task can run on a box (needs a remote to clone). id-routed to the owner. */
		remoteUrl(projectId: string): Promise<string | null>;
		list(): Promise<ProjectDTO[]>;
		remove(id: string): Promise<void>;
	};
	tasks: {
		list(projectId: string): Promise<TaskDTO[]>;
		create(input: { projectId: string; name: string; baseBranch?: string }): Promise<TaskDTO>;
		remove(input: { id: string; deleteBranch?: boolean; force?: boolean }): Promise<void>;
		setColumn(id: string, column: KanbanColumn): Promise<TaskDTO>;
		/** Clear the unread flag once the user has actually looked at the task. */
		markRead(id: string): Promise<TaskDTO>;
		/** Preview which tasks a cleanup would remove vs keep (and why). */
		cleanupPreview(projectId: string): Promise<CleanupReport>;
		/** Worktrees advised for cleanup (idle/finished), with their terminals. */
		cleanupCandidates(projectId: string): Promise<CleanupCandidate[]>;
		/** Remove merged + idle worktrees. Never deletes unmerged/active/dirty. */
		cleanup(projectId: string): Promise<CleanupReport>;
	};
	git: {
		commit(taskId: string, message: string): Promise<{ sha: string }>;
		push(taskId: string): Promise<void>;
		update(taskId: string): Promise<UpdateResultDTO>;
		/**
		 * Enqueue a merge. Merges serialize per base branch, so this resolves only
		 * when this task's turn completes — or parks on a conflict/busy/error.
		 */
		merge(taskId: string, strategy: MergeStrategy): Promise<MergeEnqueueDTO>;
		diff(taskId: string): Promise<DiffResultDTO>;
		fileDiff(taskId: string, file: string): Promise<string>;
		status(taskId: string): Promise<GitStatusSnapshot>;
	};
	agents: {
		list(): Promise<AgentDTO[]>;
	};
	search: {
		/**
		 * Find past agent sessions in this project by describing the work — the
		 * question you would otherwise open a new session to ask. Without `ai`
		 * it is an instant local rank; with it, the configured agent re-ranks
		 * the shortlist and says why each one matched.
		 */
		sessions(input: { projectId: string; query: string; ai?: boolean }): Promise<SessionHitDTO[]>;
	};
	editor: {
		/**
		 * Start (or reuse) the in-app editor for this task's engine and resolve the
		 * URL THIS client should load — tunneled for an SSH box, direct for a
		 * Tailscale endpoint, localhost for the local engine. The page is VS Code
		 * (code-server) on the task's machine; callers append ?folder=<worktree>.
		 */
		open(taskId: string): Promise<{ url: string } | { needsInstall: true }>;
		/**
		 * Install code-server on the task's engine (one-time, user-space, pinned
		 * version). Call only after the user consented to a needsInstall answer.
		 * Resolves when installed; a following open() starts it.
		 */
		install(taskId: string): Promise<void>;
	};
	fs: {
		/**
		 * Browse a directory on the *engine's* machine (the server, when remote) to
		 * pick a repo — the transport-native replacement for the local folder dialog,
		 * which would browse the wrong machine over SSH. Defaults to the engine's home
		 * dir; entries are subdirectories, each flagged when it holds a `.git`.
		 */
		listDir(path?: string): Promise<DirListingDTO>;
	};
	loops: {
		list(): Promise<LoopDTO[]>;
		setEnabled(id: string, enabled: boolean): Promise<LoopDTO[]>;
		runNow(id: string): Promise<LoopDTO[]>;
		templates(): Promise<LoopTemplateDTO[]>;
		create(input: CreateLoopInput): Promise<LoopDTO[]>;
		update(input: UpdateLoopInput): Promise<LoopDTO[]>;
		remove(id: string): Promise<LoopDTO[]>;
		onUpdated(cb: (loops: LoopDTO[]) => void): () => void;
	};
	pty: {
		spawnAgent(input: {
			taskId: string;
			agentId: string;
			yolo?: boolean;
			resume?: boolean;
			/** Launch the agent's own multi-agent board (e.g. `claude agents`) in the worktree. */
			agentMode?: boolean;
			/** Initial instruction handed to the agent at launch. */
			prompt?: string;
			/** Absolute paths to attach — appended to the prompt for the agent to read. */
			files?: string[];
		}): Promise<{ terminalId: string }>;
		spawnShell(input: { taskId: string }): Promise<{ terminalId: string }>;
		write(terminalId: string, data: string): void;
		resize(terminalId: string, cols: number, rows: number): void;
		kill(terminalId: string): void;
		snapshot(terminalId: string): Promise<PtySnapshot>;
		listForTask(taskId: string): Promise<SessionDTO[]>;
		onData(cb: (e: PtyDataEvent) => void): () => void;
		onExit(cb: (e: PtyExitEvent) => void): () => void;
	};
	events: {
		/** A task was created or changed — upsert it (add if new, replace if known). */
		onTaskUpdated(cb: (task: TaskDTO) => void): () => void;
		/** A task was removed (delete or cleanup) — drop it from every window. */
		onTaskRemoved(cb: (taskId: string) => void): () => void;
	};
	window: {
		/**
		 * Detach a project into its own OS window (to spread projects across
		 * desktops/Spaces). If a window is already bound to this project it's
		 * focused instead of duplicated.
		 */
		openProject(projectId: string): Promise<void>;
		/**
		 * The project this window is pinned to, or null for the main multi-project
		 * dashboard. Read once at boot from the window's launch URL.
		 */
		boundProjectId(): string | null;
	};
	utils: {
		/**
		 * Absolute filesystem path for a File from a drop or paste (Electron
		 * webUtils). Returns "" for a File with no backing path — e.g. a raw
		 * clipboard bitmap (screenshot) Chromium synthesizes into a File.
		 */
		pathForFile(file: File): string;
		/** Native open dialog; resolves to the chosen paths ([] on cancel). */
		pickFiles(): Promise<string[]>;
		/**
		 * Attach image files to the terminal's agent, wherever that agent runs.
		 * `paths` are client-local image files (from a drop/paste); null opens a
		 * multi-select image picker instead. The host decides the delivery: for a
		 * local agent one image is staged on the clipboard as a real bitmap
		 * ("ctrlv" — the caller forwards a Ctrl+V so the agent reads pixels, not a
		 * Finder file-icon), while several images — or an agent on a box, which
		 * can't see this machine's clipboard or files — come back as "paths" for
		 * the caller to TYPE into the PTY (box-side temp paths when remote).
		 */
		attachImages(terminalId: string, paths: string[] | null): Promise<AttachDelivery>;
		/**
		 * Attach the raw bitmap currently on the client's clipboard (a copied
		 * screenshot — no backing file). Local agents read the clipboard themselves
		 * ("ctrlv"); for an agent on a box the bitmap is shipped over and comes
		 * back as a box-side path to type. "none" when the clipboard has no image.
		 */
		attachClipboardImage(terminalId: string): Promise<AttachDelivery>;
		/**
		 * Write raw image bytes (base64) to a temp file on the *engine's* machine and
		 * return its absolute path. The remote counterpart of clipboard staging: a
		 * headless server has no GUI clipboard, so an attached/pasted image is handed
		 * to the agent as a file path (typed into the PTY or appended to its prompt)
		 * instead of a bitmap on the clipboard. `ext` sets the extension (default "png").
		 */
		writeImageBytes(base64: string, ext?: string): Promise<string>;
		/**
		 * Open a task's worktree in the user's own editor, on THIS machine. Client-native
		 * (the editor is a desktop app, not something the engine can launch), so it never
		 * routes to the engine: a task on a box is opened over VS Code's Remote-SSH using
		 * the same ssh_config alias Ateam connects with. Optional — a client with no
		 * desktop editor to hand off to (the phone) simply omits it, and callers hide the
		 * affordance rather than offering one that can't work.
		 */
		openInEditor?(worktreePath: string, alias: string | null): Promise<OpenInEditorResult>;
	};
}

export type { NativeClientApi } from "./client-api";
// Client-side binding of the AteamApi surface over an RpcClient.
export { buildAteamApi, requestBoxUpdate, serverHandshake } from "./client-api";
// Transport-agnostic RPC framing + client (shared by every transport).
export * from "./rpc";
export type { WsClient } from "./ws";
// WebSocket ClientTransport over the platform-global WebSocket (browser / RN / Bun).
export { wsClientTransport } from "./ws";

// Reading an engine older than this client (the version gate is advisory now).
export { NO_TRIAGE, tolerantRpc } from "./tolerate";
