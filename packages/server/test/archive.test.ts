import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { type AteamDb, bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import { archiveIdleTasks } from "../src/archive";
import { toTaskDTO } from "../src/services";

function createTestDb(): AteamDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	bootstrap(sqlite);
	return drizzle(sqlite, { schema }) as unknown as AteamDb;
}

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function makeTask(db: AteamDb, name: string, patch: Partial<schema.NewTask> = {}): schema.Task {
	const project =
		repo.listProjects(db)[0] ?? repo.upsertProject(db, { repoPath: "/tmp/repo", name: "repo" });
	const task = repo.createTask(db, {
		projectId: project!.id,
		name,
		slug: name,
		branch: `feat/${name}`,
		baseBranch: "main",
		worktreePath: `/tmp/repo/.ateam/worktrees/${name}`,
		column: "needs_attention",
		createdAt: NOW - 60 * DAY,
	});
	return repo.updateTask(db, task.id, patch)!;
}

const notLive = { isLive: () => false };

describe("archiveIdleTasks", () => {
	it("archives an open task idle past the threshold and nothing fresher", () => {
		const db = createTestDb();
		const idle = makeTask(db, "idle", { lastEventAt: NOW - 31 * DAY });
		const recent = makeTask(db, "recent", { lastEventAt: NOW - 3 * DAY });
		const ids = archiveIdleTasks({ db, ...notLive }, 30, NOW);
		expect(ids).toEqual([idle.id]);
		expect(repo.getTask(db, idle.id)?.archivedAt).toBe(NOW);
		expect(repo.getTask(db, recent.id)?.archivedAt).toBeNull();
	});

	it("measures idleness from the last event, never from creation when an event exists", () => {
		const db = createTestDb();
		// Created two months ago, worked on yesterday: still in play.
		const t = makeTask(db, "old-but-active", { lastEventAt: NOW - DAY });
		expect(archiveIdleTasks({ db, ...notLive }, 30, NOW)).toEqual([]);
		expect(repo.getTask(db, t.id)?.archivedAt).toBeNull();
	});

	it("falls back to creation for a task no hook ever reached, ignoring updatedAt", () => {
		const db = createTestDb();
		// The git-status sweep bumps updatedAt to now; that is not activity.
		const t = makeTask(db, "never-started", {
			gitStatus: { ahead: 0, behind: 0, dirty: 0, updatedAt: NOW },
		});
		expect(archiveIdleTasks({ db, ...notLive }, 30, NOW)).toEqual([t.id]);
	});

	it("keeps merged, live, pending-wait and loop-owned tasks", () => {
		const db = createTestDb();
		const old = { lastEventAt: NOW - 90 * DAY };
		makeTask(db, "merged", { ...old, column: "merged" });
		const live = makeTask(db, "live", old);
		makeTask(db, "waiting", { ...old, waitingReason: "review", waitingUntil: NOW + DAY });
		const looped = makeTask(db, "looped", old);
		repo.ensureLoop(db, {
			id: "loop-1",
			definitionId: "agent-session",
			kind: "user",
			templateId: "agent-session",
			name: "Monthly deps",
			config: { prompt: "update deps", taskId: looped.id },
		});
		// A wait that already resurfaced and then sat untouched is fair game.
		const firedWait = makeTask(db, "fired-wait", {
			...old,
			waitingReason: "review",
			waitingUntil: NOW - 40 * DAY,
			waitingFiredAt: NOW - 40 * DAY,
		});
		const ids = archiveIdleTasks({ db, isLive: (id) => id === live.id }, 30, NOW);
		expect(ids).toEqual([firedWait.id]);
	});

	it("does nothing when the setting is 0", () => {
		const db = createTestDb();
		makeTask(db, "idle", { lastEventAt: NOW - 400 * DAY });
		expect(archiveIdleTasks({ db, ...notLive }, 0, NOW)).toEqual([]);
	});

	it("takes archived tasks off listTasks but keeps them reachable by opt-in and by id", () => {
		const db = createTestDb();
		const t = makeTask(db, "idle", { lastEventAt: NOW - 31 * DAY });
		archiveIdleTasks({ db, ...notLive }, 30, NOW);
		const projectId = t.projectId;
		expect(repo.listTasks(db, projectId)).toEqual([]);
		expect(repo.listTasks(db, projectId, { includeArchived: true }).map((x) => x.id)).toEqual([
			t.id,
		]);
		expect(repo.listArchivedTasks(db, projectId).map((x) => x.id)).toEqual([t.id]);
		expect(toTaskDTO(repo.getTask(db, t.id)!).archivedAt).toBe(NOW);
	});

	it("gives a task brought back by hand a fresh stretch before archiving it again", () => {
		const db = createTestDb();
		const t = makeTask(db, "idle", { lastEventAt: NOW - 139 * DAY });
		expect(archiveIdleTasks({ db, ...notLive }, 30, NOW)).toEqual([t.id]);
		// Unarchive, as tasks:setArchived(false) does.
		repo.updateTask(db, t.id, { archivedAt: null, restoredAt: NOW + DAY });
		expect(archiveIdleTasks({ db, ...notLive }, 30, NOW + 2 * DAY)).toEqual([]);
		expect(archiveIdleTasks({ db, ...notLive }, 30, NOW + 31 * DAY)).toEqual([t.id]);
	});

	it("does not re-archive an archived task on the next pass", () => {
		const db = createTestDb();
		makeTask(db, "idle", { lastEventAt: NOW - 31 * DAY });
		expect(archiveIdleTasks({ db, ...notLive }, 30, NOW)).toHaveLength(1);
		expect(archiveIdleTasks({ db, ...notLive }, 30, NOW + DAY)).toEqual([]);
	});
});
