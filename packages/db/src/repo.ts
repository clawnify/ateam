import { desc, eq } from "drizzle-orm";
import type { GroveDb } from "./types";
import {
	agentEvents,
	agentSessions,
	type NewProject,
	type NewTask,
	projects,
	type Settings,
	settings,
	tasks,
} from "./schema";

/**
 * Typed data-access layer over the Grove db. Pure functions taking a `GroveDb`
 * so the same code serves the Electron main process and the in-memory tests.
 */
export const repo = {
	// ---- projects ----
	upsertProject(db: GroveDb, p: NewProject) {
		const existing = db
			.select()
			.from(projects)
			.where(eq(projects.repoPath, p.repoPath))
			.get();
		if (existing) {
			db.update(projects)
				.set({ ...p, lastOpenedAt: Date.now() })
				.where(eq(projects.id, existing.id))
				.run();
			return db.select().from(projects).where(eq(projects.id, existing.id)).get();
		}
		return db.insert(projects).values(p).returning().get();
	},

	listProjects(db: GroveDb) {
		return db
			.select()
			.from(projects)
			.orderBy(desc(projects.lastOpenedAt))
			.all();
	},

	getProject(db: GroveDb, id: string) {
		return db.select().from(projects).where(eq(projects.id, id)).get();
	},

	deleteProject(db: GroveDb, id: string) {
		db.delete(projects).where(eq(projects.id, id)).run();
	},

	// ---- tasks ----
	createTask(db: GroveDb, t: NewTask) {
		return db.insert(tasks).values(t).returning().get();
	},

	listTasks(db: GroveDb, projectId: string) {
		return db
			.select()
			.from(tasks)
			.where(eq(tasks.projectId, projectId))
			.orderBy(desc(tasks.createdAt))
			.all();
	},

	getTask(db: GroveDb, id: string) {
		return db.select().from(tasks).where(eq(tasks.id, id)).get();
	},

	updateTask(db: GroveDb, id: string, patch: Partial<NewTask>) {
		db.update(tasks)
			.set({ ...patch, updatedAt: Date.now() })
			.where(eq(tasks.id, id))
			.run();
		return repo.getTask(db, id);
	},

	deleteTask(db: GroveDb, id: string) {
		db.delete(tasks).where(eq(tasks.id, id)).run();
	},

	// ---- agent sessions & events ----
	createSession(
		db: GroveDb,
		s: { taskId: string; agentId: string; terminalId: string; cwd: string; pid?: number },
	) {
		return db.insert(agentSessions).values(s).returning().get();
	},

	getSessionByTerminal(db: GroveDb, terminalId: string) {
		return db
			.select()
			.from(agentSessions)
			.where(eq(agentSessions.terminalId, terminalId))
			.get();
	},

	listSessionsByTask(db: GroveDb, taskId: string) {
		return db
			.select()
			.from(agentSessions)
			.where(eq(agentSessions.taskId, taskId))
			.all();
	},

	updateSession(
		db: GroveDb,
		id: string,
		patch: Partial<typeof agentSessions.$inferInsert>,
	) {
		db.update(agentSessions).set(patch).where(eq(agentSessions.id, id)).run();
	},

	recordEvent(
		db: GroveDb,
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
	getSettings(db: GroveDb): Settings {
		const row = db.select().from(settings).where(eq(settings.id, 1)).get();
		if (row) return row;
		return db.insert(settings).values({ id: 1 }).returning().get();
	},

	updateSettings(db: GroveDb, patch: Partial<Settings>) {
		db.update(settings).set(patch).where(eq(settings.id, 1)).run();
		return repo.getSettings(db);
	},
};
