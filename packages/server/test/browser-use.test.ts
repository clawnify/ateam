import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { AteamDb } from "@ateam/db";
import { bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import { stampBrowserUse } from "../src/browser";
import { toTaskDTO } from "../src/services";

// The BrowserUse hook fires on every TaskWindow tool call; the task keeps the first.

function createTestDb(): AteamDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	bootstrap(sqlite);
	return drizzle(sqlite, { schema }) as unknown as AteamDb;
}

let db: AteamDb;
let taskId: string;

beforeEach(() => {
	db = createTestDb();
	const project = repo.upsertProject(db, { repoPath: "/tmp/repo", name: "Repo" });
	if (!project) throw new Error("failed to seed project");
	taskId = repo.createTask(db, {
		projectId: project.id,
		name: "t",
		slug: "t",
		branch: "feat/t",
		baseBranch: "main",
		worktreePath: "/tmp/w",
	}).id;
});

describe("stampBrowserUse", () => {
	it("stamps a task the first time its agent drives the browser, and only then", () => {
		expect(repo.getTask(db, taskId)?.browserUsedAt).toBeNull();
		expect(stampBrowserUse(db, taskId, 1000)).toBe(true);
		expect(stampBrowserUse(db, taskId, 2000)).toBe(false);
		const task = repo.getTask(db, taskId);
		expect(task?.browserUsedAt).toBe(1000);
		// What the phone reads to show the browser beside the terminal.
		if (task) expect(toTaskDTO(task).browserUsedAt).toBe(1000);
	});

	it("ignores a task that is gone", () => {
		expect(stampBrowserUse(db, "nope")).toBe(false);
	});
});
