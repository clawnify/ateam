// Plain DTOs crossing the IPC boundary. Kept dependency-free so the renderer
// never imports node/electron/db internals.

export type KanbanColumn =
	| "todo"
	| "running"
	| "needs_attention"
	| "review"
	| "merged";

export type AgentStatus = "idle" | "running" | "awaiting_input" | "stopped";

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
	slug: string;
	branch: string;
	baseBranch: string;
	worktreePath: string;
	column: KanbanColumn;
	agentStatus: AgentStatus | null;
	prNumber: number | null;
	prUrl: string | null;
	gitStatus: GitStatusSnapshot | null;
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
	gitCommit: "git:commit",
	gitPush: "git:push",
	gitUpdate: "git:update",
	gitMerge: "git:merge",
	gitDiff: "git:diff",
	gitFileDiff: "git:fileDiff",
	gitStatus: "git:status",
	agentsList: "agents:list",
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

// ---- the API surface exposed on window.grove ----
export interface GroveApi {
	projects: {
		pick(): Promise<string | null>;
		register(repoPath: string): Promise<ProjectDTO>;
		list(): Promise<ProjectDTO[]>;
		remove(id: string): Promise<void>;
	};
	tasks: {
		list(projectId: string): Promise<TaskDTO[]>;
		create(input: {
			projectId: string;
			name: string;
			baseBranch?: string;
		}): Promise<TaskDTO>;
		remove(input: {
			id: string;
			deleteBranch?: boolean;
			force?: boolean;
		}): Promise<void>;
		setColumn(id: string, column: KanbanColumn): Promise<TaskDTO>;
		/** Preview which tasks a cleanup would remove vs keep (and why). */
		cleanupPreview(projectId: string): Promise<CleanupReport>;
		/** Remove merged + idle worktrees. Never deletes unmerged/active/dirty. */
		cleanup(projectId: string): Promise<CleanupReport>;
	};
	git: {
		commit(taskId: string, message: string): Promise<{ sha: string }>;
		push(taskId: string): Promise<void>;
		update(taskId: string): Promise<UpdateResultDTO>;
		merge(taskId: string, strategy: MergeStrategy): Promise<MergeResultDTO>;
		diff(taskId: string): Promise<DiffResultDTO>;
		fileDiff(taskId: string, file: string): Promise<string>;
		status(taskId: string): Promise<GitStatusSnapshot>;
	};
	agents: {
		list(): Promise<AgentDTO[]>;
	};
	pty: {
		spawnAgent(input: {
			taskId: string;
			agentId: string;
			yolo?: boolean;
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
}
