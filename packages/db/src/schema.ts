import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Local-only SQLite schema (text-uuid PKs, epoch-ms timestamps, JSON columns).
// Collapsed model: 1 task = 1 worktree = 1 branch. The project's main worktree
// is NOT a task row, which makes "never make a task out of main" structural
// rather than a runtime check.

const pk = () => text("id").primaryKey().$defaultFn(() => randomUUID());
const epochMs = (name: string) =>
	integer(name, { mode: "number" }).$defaultFn(() => Date.now());

export type KanbanColumn =
	| "todo"
	| "running"
	| "needs_attention"
	| "review"
	| "merged";

export type AgentStatus = "idle" | "running" | "awaiting_input" | "stopped";

export type PrState = "open" | "merged" | "closed";

export interface GitStatusSnapshot {
	ahead: number;
	behind: number;
	dirty: number;
	updatedAt: number;
}

export const projects = sqliteTable(
	"projects",
	{
		id: pk(),
		repoPath: text("repo_path").notNull(),
		name: text("name").notNull(),
		defaultBranch: text("default_branch"),
		githubOwner: text("github_owner"),
		githubName: text("github_name"),
		worktreesRoot: text("worktrees_root"),
		color: text("color"),
		lastOpenedAt: epochMs("last_opened_at"),
		createdAt: epochMs("created_at"),
	},
	(t) => [
		index("projects_repo_path_idx").on(t.repoPath),
		index("projects_last_opened_idx").on(t.lastOpenedAt),
	],
);

export const tasks = sqliteTable(
	"tasks",
	{
		id: pk(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		description: text("description"),
		slug: text("slug").notNull(),
		branch: text("branch").notNull(),
		baseBranch: text("base_branch").notNull(),
		worktreePath: text("worktree_path").notNull(),
		column: text("column").$type<KanbanColumn>().notNull().default("todo"),
		agentStatus: text("agent_status").$type<AgentStatus>(),
		agentId: text("agent_id"),
		prNumber: integer("pr_number"),
		prUrl: text("pr_url"),
		prState: text("pr_state").$type<PrState>(),
		gitStatus: text("git_status", { mode: "json" }).$type<GitStatusSnapshot>(),
		lastEventAt: integer("last_event_at"),
		isUnread: integer("is_unread", { mode: "boolean" }).default(false),
		createdBy: text("created_by")
			// "grove" appears in rows written before the product rename.
			.$type<"ateam" | "grove" | "external">()
			.notNull()
			.default("ateam"),
		createdAt: epochMs("created_at"),
		updatedAt: epochMs("updated_at"),
	},
	(t) => [
		index("tasks_project_idx").on(t.projectId),
		index("tasks_branch_idx").on(t.branch),
		index("tasks_column_idx").on(t.column),
	],
);

export const agentSessions = sqliteTable(
	"agent_sessions",
	{
		id: pk(),
		taskId: text("task_id")
			.notNull()
			.references(() => tasks.id, { onDelete: "cascade" }),
		agentId: text("agent_id").notNull(),
		terminalId: text("terminal_id").notNull().unique(),
		status: text("status").$type<AgentStatus>().notNull().default("idle"),
		pid: integer("pid"),
		cwd: text("cwd").notNull(),
		startedAt: epochMs("started_at"),
		lastEventAt: integer("last_event_at"),
		exitedAt: integer("exited_at"),
	},
	(t) => [index("agent_sessions_task_idx").on(t.taskId)],
);

export const agentEvents = sqliteTable(
	"agent_events",
	{
		id: pk(),
		sessionId: text("session_id").references(() => agentSessions.id, {
			onDelete: "cascade",
		}),
		terminalId: text("terminal_id").notNull(),
		eventType: text("event_type").notNull(),
		rawAgentSessionId: text("raw_agent_session_id"),
		createdAt: epochMs("created_at"),
	},
	(t) => [index("agent_events_terminal_idx").on(t.terminalId, t.createdAt)],
);

export const layouts = sqliteTable("layouts", {
	taskId: text("task_id")
		.primaryKey()
		.references(() => tasks.id, { onDelete: "cascade" }),
	state: text("state", { mode: "json" }),
	updatedAt: epochMs("updated_at"),
});

export const settings = sqliteTable("settings", {
	id: integer("id").primaryKey().default(1),
	defaultWorktreesRoot: text("default_worktrees_root"),
	defaultAgentId: text("default_agent_id").default("claude"),
	defaultMergeStrategy: text("default_merge_strategy")
		.$type<"merge" | "squash" | "rebase">()
		.default("squash"),
	defaultUpdateStrategy: text("default_update_strategy")
		.$type<"merge" | "rebase">()
		.default("merge"),
	deleteRemoteBranchOnMerge: integer("delete_remote_branch_on_merge", {
		mode: "boolean",
	}).default(false),
	deleteLocalBranchOnRemove: integer("delete_local_branch_on_remove", {
		mode: "boolean",
	}).default(true),
	hookPort: integer("hook_port"),
	terminalFontFamily: text("terminal_font_family"),
	terminalFontSize: integer("terminal_font_size"),
	notificationsMuted: integer("notifications_muted", { mode: "boolean" }),
});

export { sql };

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type AgentSession = typeof agentSessions.$inferSelect;
export type NewAgentSession = typeof agentSessions.$inferInsert;
export type AgentEvent = typeof agentEvents.$inferSelect;
export type Settings = typeof settings.$inferSelect;
