// Plain DTOs crossing the IPC boundary. Kept dependency-free so the renderer
// never imports node/electron/db internals.

export type KanbanColumn = "todo" | "running" | "needs_attention" | "review" | "merged";

export type AgentStatus = "idle" | "running" | "awaiting_input" | "stopped";

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
	gitStatus: GitStatusSnapshot | null;
	/** Last agent/lifecycle activity (falls back to row update time). */
	lastEventAt: number | null;
	isUnread: boolean;
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
	type: "number" | "boolean";
	default: number | boolean;
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

// A worktree advised for cleanup, shown in the cleanup dialog with its terminal.
export interface CleanupCandidate {
	id: string;
	name: string;
	branch: string;
	worktreePath: string;
	reason: string;
	/** A live PTY session to show/continue, or null if the session ended. */
	terminalId: string | null;
	agentStatus: AgentStatus | null;
}

// ---- IPC channel names ----
export const CH = {
	projectsPick: "projects:pick",
	projectsRegister: "projects:register",
	projectsList: "projects:list",
	projectsRemove: "projects:remove",
	tasksList: "tasks:list",
	tasksCreate: "tasks:create",
	tasksRemove: "tasks:remove",
	tasksSetColumn: "tasks:setColumn",
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
	loopsDelete: "loops:delete",
	agentsList: "agents:list",
	utilClipboardHasImage: "util:clipboardHasImage",
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
	evtLoopsUpdated: "evt:loops:updated",
} as const;

// ---- event payloads ----
export interface PtyDataEvent {
	terminalId: string;
	data: string;
}
export interface PtyExitEvent {
	terminalId: string;
	exitCode: number;
}

// ---- the API surface exposed on window.ateam ----
export interface AteamApi {
	projects: {
		pick(): Promise<string | null>;
		/** `init: true` runs `git init` + initial commit first (after asking). */
		register(repoPath: string, opts?: { init?: boolean }): Promise<ProjectDTO>;
		list(): Promise<ProjectDTO[]>;
		remove(id: string): Promise<void>;
	};
	tasks: {
		list(projectId: string): Promise<TaskDTO[]>;
		create(input: { projectId: string; name: string; baseBranch?: string }): Promise<TaskDTO>;
		remove(input: { id: string; deleteBranch?: boolean; force?: boolean }): Promise<void>;
		setColumn(id: string, column: KanbanColumn): Promise<TaskDTO>;
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
	loops: {
		list(): Promise<LoopDTO[]>;
		setEnabled(id: string, enabled: boolean): Promise<LoopDTO[]>;
		runNow(id: string): Promise<LoopDTO[]>;
		templates(): Promise<LoopTemplateDTO[]>;
		create(input: CreateLoopInput): Promise<LoopDTO[]>;
		remove(id: string): Promise<LoopDTO[]>;
		onUpdated(cb: (loops: LoopDTO[]) => void): () => void;
	};
	pty: {
		spawnAgent(input: {
			taskId: string;
			agentId: string;
			yolo?: boolean;
			resume?: boolean;
			/** Initial instruction handed to the agent at launch. */
			prompt?: string;
		}): Promise<{ terminalId: string }>;
		spawnShell(input: { taskId: string }): Promise<{ terminalId: string }>;
		write(terminalId: string, data: string): void;
		resize(terminalId: string, cols: number, rows: number): void;
		kill(terminalId: string): void;
		snapshot(terminalId: string): Promise<string>;
		listForTask(taskId: string): Promise<SessionDTO[]>;
		onData(cb: (e: PtyDataEvent) => void): () => void;
		onExit(cb: (e: PtyExitEvent) => void): () => void;
	};
	events: {
		onTaskUpdated(cb: (task: TaskDTO) => void): () => void;
	};
	utils: {
		/** Absolute filesystem path for a dragged-in File (Electron webUtils). */
		pathForFile(file: File): string;
		/** True when the clipboard holds an image and no text (sync). */
		clipboardHasImage(): boolean;
	};
}
