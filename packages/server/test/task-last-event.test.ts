import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { AteamDb } from "@ateam/db";
import { bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import { toTaskDTO } from "../src/services";

// The sidebar's "Recently updated" sort reads TaskDTO.lastEventAt. A task no
// hook ever reached must not borrow `updatedAt`, which background writes like
// the git-status sweep bump, or a dormant task floats to the top.

function createTestDb(): AteamDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	bootstrap(sqlite);
	return drizzle(sqlite, { schema }) as unknown as AteamDb;
}

function seedTask(db: AteamDb) {
	const project = repo.upsertProject(db, { repoPath: "/tmp/repo", name: "Repo" });
	if (!project) throw new Error("failed to seed project");
	return repo.createTask(db, {
		projectId: project.id,
		name: "t",
		slug: "t",
		branch: "feat/t",
		baseBranch: "main",
		worktreePath: "/tmp/w",
	});
}

test("a task with no hook event keeps its creation time through a git-status write", () => {
	const db = createTestDb();
	const task = seedTask(db);
	const T0 = 1_700_000_000_000;
	repo.updateTask(db, task.id, { createdAt: T0 });
	// The worktree sweep writing a fresh snapshot bumps updatedAt to now.
	repo.updateTask(db, task.id, {
		gitStatus: { ahead: 0, behind: 0, dirty: 0, updatedAt: Date.now() },
	});
	const fresh = repo.getTask(db, task.id)!;
	expect(fresh.updatedAt).toBeGreaterThan(T0);
	expect(toTaskDTO(fresh).lastEventAt).toBe(T0);
});

test("a real hook event wins over the creation time", () => {
	const db = createTestDb();
	const task = seedTask(db);
	const T1 = 1_700_000_500_000;
	repo.updateTask(db, task.id, { createdAt: 1_700_000_000_000, lastEventAt: T1 });
	expect(toTaskDTO(repo.getTask(db, task.id)!).lastEventAt).toBe(T1);
});
