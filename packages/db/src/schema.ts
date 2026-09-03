import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Local-only SQLite schema (text-uuid PKs, epoch-ms timestamps, JSON columns).
// Collapsed model: 1 task = 1 worktree = 1 branch. The project's main worktree
// is NOT a task row, which makes "never make a task out of main" structural
// rather than a runtime check.

const pk = () =>
	text("id")
		.primaryKey()
		.$defaultFn(() => randomUUID());
const epochMs = (name: string) => integer(name, { mode: "number" }).$defaultFn(() => Date.now());

export type KanbanColumn = "todo" | "running" | "needs_attention" | "review" | "merged";

export type AgentStatus = "idle" | "running" | "awaiting_input" | "stopped";

export type PrState = "open" | "merged" | "closed";

/**
 * How a terminal session ended. The distinction exists for exactly one reason:
 * only `stranded` and `reaped` sessions are offered back as restorable tabs.
 *
 * - `closed`   — you closed the tab (its PTY was killed on purpose).
 * - `exited`   — the shell behind it ended on its own while the app watched.
 * - `stranded` — it was still open when the app or the machine went down, and
 *                the PTY daemon had forgotten it by the time we reconnected.
 * - `reaped`   — it finished its turn and sat idle long enough that the app
 *                reclaimed the process (see pty/reap.ts). Unlike `stranded`,
 *                this survives a restart: the ending was deliberate, so the tab
 *                stays on offer until the user brings it back or supersedes it.
 * - `restored` — a stranded or reaped session whose conversation has since been
 *                picked back up in a new tab, so it is no longer offered.
 */
export type SessionExitReason = "closed" | "exited" | "stranded" | "reaped" | "restored";

/**
 * Where a task sits in the merge queue. `null` = not queued. The queue is
 * serialized per `${repoPath}::${baseBranch}`, so several tasks targeting the
 * same base sit in `queued` behind whichever is `updating`/`merging`.
 */
export type MergeStatus = "queued" | "updating" | "merging" | "conflict";

/** Cadence of a Loop: a fixed cron-like interval, or self-paced like /loop. */
export type LoopCadenceMode = "fixed" | "self_paced";

/** Outcome class of a Loop's last run, surfaced in the Loops panel. */
export type LoopRunStatus = "ok" | "error" | "done";

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
		mergeStatus: text("merge_status").$type<MergeStatus>(),
		gitStatus: text("git_status", { mode: "json" }).$type<GitStatusSnapshot>(),
		/**
		 * Model-assigned topic tags, written once shortly after the agent starts.
		 * Stored rather than derived because a model's answer cannot be recomputed:
		 * the keyword fallback in the renderer covers rows that predate this or
		 * whose tagging call failed.
		 */
		tags: text("tags", { mode: "json" }).$type<string[]>(),
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
		/**
		 * The HARNESS's own conversation id — the handle its resume command takes.
		 * Equal to `terminalId` when we minted it (see `sessionIdFlag`), and
		 * carried forward unchanged onto the row of a tab restored from it: the
		 * PTY is new, the conversation is not. Null for a harness that mints its
		 * own id, and for every session that predates this column.
		 */
		agentSessionId: text("agent_session_id"),
		status: text("status").$type<AgentStatus>().notNull().default("idle"),
		pid: integer("pid"),
		cwd: text("cwd").notNull(),
		startedAt: epochMs("started_at"),
		lastEventAt: integer("last_event_at"),
		exitedAt: integer("exited_at"),
		/** How this session ended — see `SessionExitReason`. Null while it runs. */
		exitReason: text("exit_reason").$type<SessionExitReason>(),
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
	/**
	 * The last PATH successfully resolved from this machine's login shell.
	 * A GUI launch inherits launchd's PATH, and when the startup probe that
	 * repairs that misses, this is what the engine falls back to instead of
	 * leaving every agent CLI and `gh` unreachable (see login-env.ts).
	 */
	loginPath: text("login_path"),
});

/**
 * Persisted runtime state for Loops (periodic reconcilers, modeled on Claude
 * Code's /loop). One row per live loop: a global loop has `id == definitionId`
 * and null `scopeKey`; a per-task loop has `id == "<definitionId>:<taskId>"`
 * with `scopeKey == taskId`. Built-in loops are defined in code; `kind="user"`
 * rows ARE the definition — an instance of a code-side template (`templateId`)
 * with a `name`, a `projectId` scope, JSON `config`, and a cadence override.
 * The table carries enable + last-run telemetry either way, so loops survive
 * restarts and the UI can show/toggle/run-now.
 */
export const loops = sqliteTable(
	"loops",
	{
		id: text("id").primaryKey(),
		definitionId: text("definition_id").notNull(),
		scopeKey: text("scope_key"),
		kind: text("kind").$type<"builtin" | "user">().notNull().default("builtin"),
		/** For user loops: which code-side template this instantiates. */
		templateId: text("template_id"),
		/** User loops: display name + project scope + template options (JSON). */
		name: text("name"),
		projectId: text("project_id").references(() => projects.id, {
			onDelete: "cascade",
		}),
		config: text("config", { mode: "json" }).$type<Record<string, unknown>>(),
		/** Cadence override for user loops; null falls back to template default. */
		cadenceMode: text("cadence_mode").$type<LoopCadenceMode>(),
		intervalMs: integer("interval_ms"),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		lastRunAt: integer("last_run_at"),
		nextRunAt: integer("next_run_at"),
		lastStatus: text("last_status").$type<LoopRunStatus>(),
		lastSummary: text("last_summary"),
		lastError: text("last_error"),
		runs: integer("runs").notNull().default(0),
		createdAt: epochMs("created_at"),
		updatedAt: epochMs("updated_at"),
	},
	(t) => [index("loops_definition_idx").on(t.definitionId)],
);

/**
 * Audit trail for board moves made by the agent-driven Board Organizer loop.
 * Every applied `set_status` writes one row so a misfiled card is always
 * traceable (and reversible): what moved, from where to where, and the
 * organizer's stated reason. Only APPROVED moves land here — rejections are
 * dropped by the guardrail before this point.
 */
export const boardChanges = sqliteTable(
	"board_changes",
	{
		id: pk(),
		taskId: text("task_id")
			.notNull()
			.references(() => tasks.id, { onDelete: "cascade" }),
		fromColumn: text("from_column").$type<KanbanColumn>().notNull(),
		toColumn: text("to_column").$type<KanbanColumn>().notNull(),
		reason: text("reason").notNull(),
		/** Who made the move — the organizer today; leaves room for other sources. */
		source: text("source").notNull().default("organizer"),
		createdAt: epochMs("created_at"),
	},
	(t) => [index("board_changes_task_idx").on(t.taskId)],
);

/**
 * Remote hosts the client can drive an engine on, keyed by `host_alias` — the
 * connection's identity, whose meaning depends on `transport`:
 *
 *   ssh  the `~/.ssh/config` alias. Connection details (hostname/port/keys/
 *        jumphosts) stay OpenSSH's job; we never store them.
 *   ws   the `host:port` endpoint itself, on the box's Tailscale address. There
 *        is no ssh_config to defer to, so the identity IS the endpoint — which
 *        keeps this column a single opaque key either way, with no second
 *        naming concept to keep unique or rename.
 *
 * Beyond that we persist only Ateam's own metadata — the last handshake version,
 * which agents the box has, when it was last reached. This doubles as the offline
 * cache: the connections list renders every known host from here without opening
 * N live connections. Client-only state — the engine never reads this table.
 */
export const hosts = sqliteTable(
	"hosts",
	{
		hostAlias: text("host_alias").primaryKey(),
		/** How to open it: "ssh" (an ssh_config alias) or "ws" (a host:port endpoint). */
		transport: text("transport").notNull().default("ssh"),
		serverVersion: text("server_version"),
		agentsAvailable: text("agents_available", { mode: "json" }).$type<string[]>(),
		lastSeen: integer("last_seen"),
		/** User removed it from the connections list. An ssh_config alias can't be
		 *  deleted (the config would resurface it), so it's flagged instead; a later
		 *  successful connection clears the flag. */
		hidden: integer("hidden").notNull().default(0),
		createdAt: epochMs("created_at"),
	},
	(t) => [index("hosts_last_seen_idx").on(t.lastSeen)],
);

export { sql };

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type AgentSession = typeof agentSessions.$inferSelect;
export type NewAgentSession = typeof agentSessions.$inferInsert;
export type AgentEvent = typeof agentEvents.$inferSelect;
export type Settings = typeof settings.$inferSelect;
export type Loop = typeof loops.$inferSelect;
export type NewLoop = typeof loops.$inferInsert;
export type BoardChange = typeof boardChanges.$inferSelect;
export type NewBoardChange = typeof boardChanges.$inferInsert;
export type Host = typeof hosts.$inferSelect;
export type NewHost = typeof hosts.$inferInsert;
