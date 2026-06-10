import { desc, eq } from "drizzle-orm";
import {
	agentEvents,
	agentSessions,
	type Loop,
	loops,
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
};
