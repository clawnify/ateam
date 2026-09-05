import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
	agentEvents,
	agentSessions,
	type BoardChange,
	boardChanges,
	type Host,
	hosts,
	type Loop,
	loops,
	type NewBoardChange,
	type NewLoop,
	type NewProject,
	type NewTask,
	projects,
	type Settings,
	settings,
	tasks,
} from "./schema";
import type { AteamDb } from "./types";

/**
 * Typed data-access layer over the Ateam db. Pure functions taking a `AteamDb`
 * so the same code serves the Electron main process and the in-memory tests.
 */
export const repo = {
	// ---- projects ----
	upsertProject(db: AteamDb, p: NewProject) {
		const existing = db.select().from(projects).where(eq(projects.repoPath, p.repoPath)).get();
		if (existing) {
			db.update(projects)
				.set({ ...p, lastOpenedAt: Date.now() })
				.where(eq(projects.id, existing.id))
				.run();
			return db.select().from(projects).where(eq(projects.id, existing.id)).get();
		}
		return db.insert(projects).values(p).returning().get();
	},

	listProjects(db: AteamDb) {
		return db.select().from(projects).orderBy(desc(projects.lastOpenedAt)).all();
	},

	getProject(db: AteamDb, id: string) {
		return db.select().from(projects).where(eq(projects.id, id)).get();
	},

	/** Patch specific columns. Unlike upsertProject this does NOT touch
	 *  lastOpenedAt, which orders the sidebar — a background repair must not
	 *  reshuffle the board. */
	updateProject(db: AteamDb, id: string, patch: Partial<NewProject>) {
		db.update(projects).set(patch).where(eq(projects.id, id)).run();
		return repo.getProject(db, id);
	},

	deleteProject(db: AteamDb, id: string) {
		db.delete(projects).where(eq(projects.id, id)).run();
	},

	// ---- tasks ----
	createTask(db: AteamDb, t: NewTask) {
		return db.insert(tasks).values(t).returning().get();
	},

	listTasks(db: AteamDb, projectId: string) {
		return db
			.select()
			.from(tasks)
			.where(eq(tasks.projectId, projectId))
			.orderBy(desc(tasks.createdAt))
			.all();
	},

	getTask(db: AteamDb, id: string) {
		return db.select().from(tasks).where(eq(tasks.id, id)).get();
	},

	updateTask(db: AteamDb, id: string, patch: Partial<NewTask>) {
		db.update(tasks)
			.set({ ...patch, updatedAt: Date.now() })
			.where(eq(tasks.id, id))
			.run();
		return repo.getTask(db, id);
	},

	deleteTask(db: AteamDb, id: string) {
		db.delete(tasks).where(eq(tasks.id, id)).run();
	},

	// ---- agent sessions & events ----
	createSession(
		db: AteamDb,
		s: {
			taskId: string;
			agentId: string;
			terminalId: string;
			cwd: string;
			pid?: number;
			/** The harness's own conversation id, when we know it. */
			agentSessionId?: string | null;
		},
	) {
		return db.insert(agentSessions).values(s).returning().get();
	},

	getSessionByTerminal(db: AteamDb, terminalId: string) {
		return db.select().from(agentSessions).where(eq(agentSessions.terminalId, terminalId)).get();
	},

	// Latest-first: callers that want the most recent chat session (e.g. the
	// cleanup preview) can take the first live one without re-sorting.
	listSessionsByTask(db: AteamDb, taskId: string) {
		return db
			.select()
			.from(agentSessions)
			.where(eq(agentSessions.taskId, taskId))
			.orderBy(desc(agentSessions.startedAt))
			.all();
	},

	// Every session the db still believes is running, across all projects. The
	// engine diffs this against the PTY daemon's live set on connect to find
	// exits that happened while the app was closed (see pty/stranded.ts).
	listOpenSessions(db: AteamDb) {
		return db.select().from(agentSessions).where(isNull(agentSessions.exitedAt)).all();
	},

	updateSession(db: AteamDb, id: string, patch: Partial<typeof agentSessions.$inferInsert>) {
		db.update(agentSessions).set(patch).where(eq(agentSessions.id, id)).run();
	},

	/**
	 * The tabs this task had open when the app last went down — what the panel
	 * offers to bring back. Newest first, like `listSessionsByTask`.
	 *
	 * Deliberately NOT "every session that never got closed". A task in this db
	 * has held as many as 28 sessions over its life, and a strip of 28 dead tabs
	 * is not a restore, it is a history browser nobody asked for. Both sources
	 * are bounded to keep it that way: `stranded` is kept to one app run by
	 * `demoteStrandedSessions`, and `reaped` to one per task by
	 * `demoteReapedSessions`.
	 */
	listRestorableSessions(db: AteamDb, taskId: string) {
		return db
			.select()
			.from(agentSessions)
			.where(
				and(
					eq(agentSessions.taskId, taskId),
					inArray(agentSessions.exitReason, ["stranded", "reaped"]),
				),
			)
			.orderBy(desc(agentSessions.startedAt))
			.all();
	},

	/**
	 * Retire the previous run's stranded sessions to plain history. Called once
	 * per app run, just before the new sweep marks its own: a tab you did not
	 * bring back during a whole run of the app is not still "open", and without
	 * this the strip would accumulate one run's worth of ghosts after another.
	 */
	demoteStrandedSessions(db: AteamDb) {
		db.update(agentSessions)
			.set({ exitReason: "exited" })
			.where(eq(agentSessions.exitReason, "stranded"))
			.run();
	},

	/**
	 * Retire a task's previously reaped tabs to plain history. A task holds one
	 * live session at a time, so a fresh reap supersedes any earlier one. Without
	 * this, a task the user never brings back would collect a dead tab per reap —
	 * the same history-browser strip `listRestorableSessions` exists to avoid.
	 */
	demoteReapedSessions(db: AteamDb, taskId: string) {
		db.update(agentSessions)
			.set({ exitReason: "exited" })
			.where(and(eq(agentSessions.taskId, taskId), eq(agentSessions.exitReason, "reaped")))
			.run();
	},

	/**
	 * The terminal a harness's OWN session id is running on — the link between a
	 * transcript on disk and the PTY tab that produced it, which session search
	 * uses to open the exact terminal a result came from.
	 *
	 * Reads `agent_sessions.agent_session_id`, the id Ateam hands the agent at
	 * launch. It used to read `agent_events.raw_agent_session_id`, which was fed
	 * from a `$CLAUDE_SESSION_ID` the hook environment never defines: every one
	 * of the 20k rows in a real db holds an empty string, so this lookup could
	 * only ever return nothing and no search hit was ever clickable.
	 *
	 * Newest first, because a conversation resumed into a fresh tab keeps its id
	 * while the terminal changes — the latest row is the tab it lives in now.
	 */
	findTerminalByAgentSessionId(db: AteamDb, agentSessionId: string) {
		return db
			.select({ terminalId: agentSessions.terminalId })
			.from(agentSessions)
			.where(eq(agentSessions.agentSessionId, agentSessionId))
			.orderBy(desc(agentSessions.startedAt))
			.get()?.terminalId;
	},

	recordEvent(
		db: AteamDb,
		e: {
			sessionId?: string | null;
			terminalId: string;
			eventType: string;
			rawAgentSessionId?: string | null;
		},
	) {
		return db.insert(agentEvents).values(e).returning().get();
	},

	// ---- settings (single row, id=1) ----
	getSettings(db: AteamDb): Settings {
		const row = db.select().from(settings).where(eq(settings.id, 1)).get();
		if (row) return row;
		return db.insert(settings).values({ id: 1 }).returning().get();
	},

	updateSettings(db: AteamDb, patch: Partial<Settings>) {
		db.update(settings).set(patch).where(eq(settings.id, 1)).run();
		return repo.getSettings(db);
	},

	// ---- loops (periodic reconcilers; one row per live loop instance) ----
	listLoops(db: AteamDb): Loop[] {
		return db.select().from(loops).all();
	},

	getLoop(db: AteamDb, id: string): Loop | undefined {
		return db.select().from(loops).where(eq(loops.id, id)).get();
	},

	/**
	 * The loop that owns this task, if any. A loop keeps its persistent task's
	 * id in its config (`lastTaskId` on rows written before the persistent-task
	 * pivot), so the reverse link is a scan of the handful of loop rows rather
	 * than an index — gate calls on a once-per-session event, not a hot path.
	 */
	loopForTask(db: AteamDb, taskId: string): Loop | undefined {
		return repo
			.listLoops(db)
			.find((l) => l.config?.taskId === taskId || l.config?.lastTaskId === taskId);
	},

	/**
	 * Ensure a row exists for a loop instance, returning it. Existing rows keep
	 * their persisted `enabled`/telemetry; only first creation seeds defaults.
	 */
	ensureLoop(db: AteamDb, l: NewLoop): Loop {
		const existing = repo.getLoop(db, l.id);
		if (existing) return existing;
		return db.insert(loops).values(l).returning().get();
	},

	updateLoop(db: AteamDb, id: string, patch: Partial<NewLoop>): Loop | undefined {
		db.update(loops)
			.set({ ...patch, updatedAt: Date.now() })
			.where(eq(loops.id, id))
			.run();
		return repo.getLoop(db, id);
	},

	deleteLoop(db: AteamDb, id: string) {
		db.delete(loops).where(eq(loops.id, id)).run();
	},

	// ---- board changes (organizer audit trail) ----
	recordBoardChange(db: AteamDb, c: NewBoardChange): BoardChange {
		return db.insert(boardChanges).values(c).returning().get();
	},

	/** Most-recent-first audit of organizer moves; optionally scoped to one task. */
	listBoardChanges(db: AteamDb, opts: { taskId?: string; limit?: number } = {}): BoardChange[] {
		const q = db.select().from(boardChanges);
		const rows = (opts.taskId ? q.where(eq(boardChanges.taskId, opts.taskId)) : q)
			.orderBy(desc(boardChanges.createdAt))
			.all();
		return opts.limit ? rows.slice(0, opts.limit) : rows;
	},

	// ---- hosts (remote connections; client-only) ----
	/** Insert or update a host record by its ssh_config alias. */
	upsertHost(db: AteamDb, h: Partial<Host> & { hostAlias: string }): Host {
		const existing = db.select().from(hosts).where(eq(hosts.hostAlias, h.hostAlias)).get();
		if (existing) {
			db.update(hosts).set(h).where(eq(hosts.hostAlias, h.hostAlias)).run();
			return db.select().from(hosts).where(eq(hosts.hostAlias, h.hostAlias)).get() as Host;
		}
		return db.insert(hosts).values(h).returning().get();
	},

	/** All known hosts, most-recently-reached first (nulls — never connected — last). */
	listHosts(db: AteamDb): Host[] {
		return db.select().from(hosts).orderBy(desc(hosts.lastSeen)).all();
	},

	getHost(db: AteamDb, hostAlias: string): Host | undefined {
		return db.select().from(hosts).where(eq(hosts.hostAlias, hostAlias)).get();
	},

	/** Forget a host — drops only our metadata; ~/.ssh/config is untouched. */
	deleteHost(db: AteamDb, hostAlias: string): void {
		db.delete(hosts).where(eq(hosts.hostAlias, hostAlias)).run();
	},
};
