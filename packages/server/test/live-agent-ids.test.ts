import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { AteamDb } from "@ateam/db";
import { bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import { liveAgentIds } from "../src/services";

// The glyphs a card shows for what runs in a task (TaskDTO.agentIds) come from
// this: live sessions only, in the order they were opened.

function createTestDb(): AteamDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	bootstrap(sqlite);
	return drizzle(sqlite, { schema }) as unknown as AteamDb;
}

test("lists the agent of every live session, oldest first, and skips dead ones", () => {
	const db = createTestDb();
	const project = repo.upsertProject(db, { repoPath: "/tmp/repo", name: "Repo" });
	if (!project) throw new Error("failed to seed project");
	const task = repo.createTask(db, {
		projectId: project.id,
		name: "t",
		slug: "t",
		branch: "feat/t",
		baseBranch: "main",
		worktreePath: "/tmp/w",
	});
	const T0 = 1_700_000_000_000;
	for (const [i, [agentId, terminalId]] of [
		["claude", "a"],
		["shell", "b"],
		["claude", "c"],
		["codex", "dead"],
	].entries()) {
		repo.createSession(db, { taskId: task.id, agentId, terminalId, cwd: "/tmp/w" });
		// Spread the start times so "oldest first" is a real ordering to test.
		repo.updateSession(db, repo.getSessionByTerminal(db, terminalId)!.id, {
			startedAt: T0 + i * 1000,
		});
	}
	const pty = { has: (id: string) => id !== "dead" };
	expect(liveAgentIds(db, pty, task.id)).toEqual(["claude", "shell", "claude"]);
	expect(liveAgentIds(db, { has: () => false }, task.id)).toEqual([]);
});
