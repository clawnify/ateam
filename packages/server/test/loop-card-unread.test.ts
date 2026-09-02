import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { AteamDb } from "@ateam/db";
import { bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import { mapEventToUnread } from "../src/engine";

function createTestDb(): AteamDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	bootstrap(sqlite);
	return drizzle(sqlite, { schema }) as unknown as AteamDb;
}

let db: AteamDb;

function seedTask(name: string): string {
	const project = repo.upsertProject(db, {
		repoPath: "/tmp/repo",
		name: "Repo",
		defaultBranch: "main",
	});
	if (!project) throw new Error("failed to seed project");
	return repo.createTask(db, {
		projectId: project.id,
		name,
		slug: name,
		branch: `loop/${name}`,
		baseBranch: "main",
		worktreePath: `/tmp/${name}`,
	}).id;
}

function seedLoop(id: string, config: Record<string, unknown>): void {
	repo.ensureLoop(db, {
		id,
		definitionId: id,
		scopeKey: null,
		kind: "user",
		templateId: "agent-session",
		name: "Nightly",
		projectId: null,
		config,
		cadenceMode: "fixed",
		intervalMs: 3_600_000,
		enabled: true,
	});
}

beforeEach(() => {
	db = createTestDb();
});

describe("mapEventToUnread", () => {
	it("marks a normal task unread when its agent stops", () => {
		expect(mapEventToUnread("Stop", false)).toBe(true);
	});

	it("stays silent when a loop's tick ends on schedule", () => {
		expect(mapEventToUnread("Stop", true)).toBe(false);
	});

	it("still shouts when a loop is blocked on the user", () => {
		expect(mapEventToUnread("PermissionRequest", true)).toBe(true);
	});

	it("is never news mid-turn", () => {
		expect(mapEventToUnread("Working", false)).toBe(false);
		expect(mapEventToUnread("Start", false)).toBe(false);
	});
});

describe("repo.loopForTask", () => {
	it("finds the loop that owns a task", () => {
		const taskId = seedTask("owned");
		seedLoop("loop-1", { prompt: "go", taskId });
		expect(repo.loopForTask(db, taskId)?.id).toBe("loop-1");
	});

	it("finds it through the pre-pivot lastTaskId key", () => {
		const taskId = seedTask("legacy");
		seedLoop("loop-2", { prompt: "go", lastTaskId: taskId });
		expect(repo.loopForTask(db, taskId)?.id).toBe("loop-2");
	});

	it("returns undefined for a task no loop owns", () => {
		const mine = seedTask("mine");
		seedLoop("loop-3", { prompt: "go", taskId: seedTask("theirs") });
		expect(repo.loopForTask(db, mine)).toBeUndefined();
	});
});
