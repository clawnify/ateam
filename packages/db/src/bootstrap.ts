import type { SqliteExecutor } from "./types";

/**
 * Create all tables/indexes if absent. For an MVP local app this explicit DDL
 * is simpler and more deterministic than wiring drizzle-kit migrations into the
 * Electron build; it must stay in sync with schema.ts. The DDL is idempotent.
 * Accepts any executor with `.exec()` (better-sqlite3 or bun:sqlite Database).
 */
export function bootstrap(db: SqliteExecutor): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS projects (
			id TEXT PRIMARY KEY,
			repo_path TEXT NOT NULL,
			name TEXT NOT NULL,
			default_branch TEXT,
			github_owner TEXT,
			github_name TEXT,
			worktrees_root TEXT,
			color TEXT,
			last_opened_at INTEGER,
			created_at INTEGER
		);
		CREATE INDEX IF NOT EXISTS projects_repo_path_idx ON projects (repo_path);
		CREATE INDEX IF NOT EXISTS projects_last_opened_idx ON projects (last_opened_at);

		CREATE TABLE IF NOT EXISTS tasks (
			id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			description TEXT,
			slug TEXT NOT NULL,
			branch TEXT NOT NULL,
			base_branch TEXT NOT NULL,
			worktree_path TEXT NOT NULL,
			"column" TEXT NOT NULL DEFAULT 'todo',
			agent_status TEXT,
			agent_id TEXT,
			pr_number INTEGER,
			pr_url TEXT,
			pr_state TEXT,
			git_status TEXT,
			last_event_at INTEGER,
			is_unread INTEGER DEFAULT 0,
			created_by TEXT NOT NULL DEFAULT 'ateam',
			created_at INTEGER,
			updated_at INTEGER
		);
		CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks (project_id);
		CREATE INDEX IF NOT EXISTS tasks_branch_idx ON tasks (branch);
		CREATE INDEX IF NOT EXISTS tasks_column_idx ON tasks ("column");

		CREATE TABLE IF NOT EXISTS agent_sessions (
			id TEXT PRIMARY KEY,
			task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
			agent_id TEXT NOT NULL,
			terminal_id TEXT NOT NULL UNIQUE,
			status TEXT NOT NULL DEFAULT 'idle',
			pid INTEGER,
			cwd TEXT NOT NULL,
			started_at INTEGER,
			last_event_at INTEGER,
			exited_at INTEGER
		);
		CREATE INDEX IF NOT EXISTS agent_sessions_task_idx ON agent_sessions (task_id);

		CREATE TABLE IF NOT EXISTS agent_events (
			id TEXT PRIMARY KEY,
			session_id TEXT REFERENCES agent_sessions(id) ON DELETE CASCADE,
			terminal_id TEXT NOT NULL,
			event_type TEXT NOT NULL,
			raw_agent_session_id TEXT,
			created_at INTEGER
		);
		CREATE INDEX IF NOT EXISTS agent_events_terminal_idx ON agent_events (terminal_id, created_at);

		CREATE TABLE IF NOT EXISTS layouts (
			task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
			state TEXT,
			updated_at INTEGER
		);

		CREATE TABLE IF NOT EXISTS settings (
			id INTEGER PRIMARY KEY DEFAULT 1,
			default_worktrees_root TEXT,
			default_agent_id TEXT DEFAULT 'claude',
			default_merge_strategy TEXT DEFAULT 'squash',
			default_update_strategy TEXT DEFAULT 'merge',
			delete_remote_branch_on_merge INTEGER DEFAULT 0,
			delete_local_branch_on_remove INTEGER DEFAULT 1,
			hook_port INTEGER,
			terminal_font_family TEXT,
			terminal_font_size INTEGER,
			notifications_muted INTEGER
		);
		INSERT OR IGNORE INTO settings (id) VALUES (1);

		CREATE TABLE IF NOT EXISTS loops (
			id TEXT PRIMARY KEY,
			definition_id TEXT NOT NULL,
			scope_key TEXT,
			kind TEXT NOT NULL DEFAULT 'builtin',
			template_id TEXT,
			name TEXT,
			project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
			config TEXT,
			cadence_mode TEXT,
			interval_ms INTEGER,
			enabled INTEGER NOT NULL DEFAULT 1,
			last_run_at INTEGER,
			next_run_at INTEGER,
			last_status TEXT,
			last_summary TEXT,
			last_error TEXT,
			runs INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER,
			updated_at INTEGER
		);
		CREATE INDEX IF NOT EXISTS loops_definition_idx ON loops (definition_id);

		CREATE TABLE IF NOT EXISTS board_changes (
			id TEXT PRIMARY KEY,
			task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
			from_column TEXT NOT NULL,
			to_column TEXT NOT NULL,
			reason TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'organizer',
			created_at INTEGER
		);
		CREATE INDEX IF NOT EXISTS board_changes_task_idx ON board_changes (task_id);

			CREATE TABLE IF NOT EXISTS hosts (
				host_alias TEXT PRIMARY KEY,
				server_version TEXT,
				agents_available TEXT,
				last_seen INTEGER,
				created_at INTEGER,
				transport TEXT DEFAULT 'ssh',
				endpoint TEXT
			);
			CREATE INDEX IF NOT EXISTS hosts_last_seen_idx ON hosts (last_seen);
	`);

	// Migrations for databases created before a column existed. SQLite has no
	// "ADD COLUMN IF NOT EXISTS", so attempt and ignore the "duplicate" error.
	for (const sql of [
		"ALTER TABLE tasks ADD COLUMN agent_id TEXT",
		"ALTER TABLE tasks ADD COLUMN description TEXT",
		"ALTER TABLE tasks ADD COLUMN merge_status TEXT",
		"ALTER TABLE loops ADD COLUMN kind TEXT NOT NULL DEFAULT 'builtin'",
		"ALTER TABLE loops ADD COLUMN template_id TEXT",
		"ALTER TABLE loops ADD COLUMN name TEXT",
		"ALTER TABLE loops ADD COLUMN project_id TEXT",
		"ALTER TABLE loops ADD COLUMN config TEXT",
		"ALTER TABLE loops ADD COLUMN cadence_mode TEXT",
		"ALTER TABLE loops ADD COLUMN interval_ms INTEGER",
		"ALTER TABLE hosts ADD COLUMN transport TEXT DEFAULT 'ssh'",
		"ALTER TABLE hosts ADD COLUMN endpoint TEXT",
	]) {
		try {
			db.exec(sql);
		} catch {
			/* column already exists */
		}
	}
}
