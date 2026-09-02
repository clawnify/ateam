import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AteamDb } from "@ateam/db";
import { bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import { FollowUps } from "../src/follow-ups";
import type { Services } from "../src/services";
import { spawnAgentInTask } from "../src/sessions";

// Opening a stopped task auto-resumes its conversation, so a resume must be
// side-effect free on the board: the card keeps its column, status and "last
// activity" until the user actually types. Driven through the real spawn path
// with a PTY client that records instead of forking.

function createTestDb(): AteamDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	bootstrap(sqlite);
	return drizzle(sqlite, { schema }) as unknown as AteamDb;
}

let db: AteamDb;
let services: Services;
let taskId: string;
const T0 = 1_700_000_000_000;

beforeEach(() => {
	db = createTestDb();
	const scratch = mkdtempSync(join(tmpdir(), "ateam-spawn-"));
	services = {
		db,
		pty: { spawn: () => "pty", has: () => false },
		hooksDir: scratch,
		notifyScriptPath: join(scratch, "notify.sh"),
		hookPort: 0,
		followUps: new FollowUps(),
	} as unknown as Services;
	const project = repo.upsertProject(db, {
		repoPath: "/tmp/repo",
		name: "Repo",
		defaultBranch: "main",
	});
	if (!project) throw new Error("failed to seed project");
	const task = repo.createTask(db, {
		projectId: project.id,
		name: "stopped task",
		slug: "stopped-task",
		branch: "feat/stopped",
		baseBranch: "main",
		worktreePath: scratch,
	});
	// The card as a stopped agent leaves it: parked on a question, last heard
	// from at T0.
	repo.updateTask(db, task.id, {
		column: "needs_attention",
		agentStatus: "stopped",
		lastEventAt: T0,
	});
	taskId = task.id;
});

describe("spawnAgentInTask on resume", () => {
	it("`--continue` leaves column, status and last activity untouched", async () => {
		await spawnAgentInTask(services, () => {}, { taskId, agentId: "claude", resume: true });
		const task = repo.getTask(db, taskId);
		expect(task).toMatchObject({
			column: "needs_attention",
			agentStatus: "stopped",
			lastEventAt: T0,
			agentId: "claude",
		});
	});

	it("resuming a specific conversation leaves the card where it was too", async () => {
		await spawnAgentInTask(services, () => {}, {
			taskId,
			agentId: "claude",
			resumeSessionId: "11111111-1111-4111-8111-111111111111",
		});
		const task = repo.getTask(db, taskId);
		expect(task).toMatchObject({
			column: "needs_attention",
			agentStatus: "stopped",
			lastEventAt: T0,
		});
	});

	it("a launch that carries a prompt still files the card as running", async () => {
		await spawnAgentInTask(services, () => {}, {
			taskId,
			agentId: "claude",
			prompt: "fix the bug",
		});
		const task = repo.getTask(db, taskId);
		expect(task).toMatchObject({ column: "running", agentStatus: "running", lastEventAt: T0 });
	});
});
