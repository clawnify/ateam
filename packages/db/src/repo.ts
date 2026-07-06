import { desc, eq } from "drizzle-orm";
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
		s: { taskId: string; agentId: string; terminalId: string; cwd: string; pid?: number },
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

	updateSession(db: AteamDb, id: string, patch: Partial<typeof agentSessions.$inferInsert>) {
		db.update(agentSessions).set(patch).where(eq(agentSessions.id, id)).run();
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
