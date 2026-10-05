import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { AteamDb } from "@ateam/db";
import { bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import { applyAgentQuit } from "../src/pty/agent-quit";
import { liveAgentIds } from "../src/services";

// A pane runs `<agent>; notify AgentExit; exec $SHELL -l`, so the agent can quit
// while its PTY lives on as a shell. AgentExit is the only word of that ending.

function createTestDb(): AteamDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	bootstrap(sqlite);
	return drizzle(sqlite, { schema }) as unknown as AteamDb;
}

let db: AteamDb;
let taskId: string;
const allLive = { has: () => true };

function addSession(agentId: string, terminalId: string, status = "idle") {
	repo.createSession(db, { taskId, agentId, terminalId, cwd: "/tmp/w" });
	const row = repo.getSessionByTerminal(db, terminalId);
	if (!row) throw new Error("failed to seed session");
	repo.updateSession(db, row.id, { status: status as "idle" });
	return repo.getSessionByTerminal(db, terminalId) as NonNullable<typeof row>;
}

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

describe("applyAgentQuit", () => {
	it("stops the session and clears a question the agent took with it", () => {
		const s = addSession("claude", "a", "awaiting_input");
		repo.updateTask(db, taskId, { column: "needs_attention", agentStatus: "awaiting_input" });
		expect(applyAgentQuit(db, allLive, s)).toBe(taskId);
		expect(repo.getSessionByTerminal(db, "a")).toMatchObject({ status: "stopped", exitedAt: null });
		// The column is the user's queue; only a `running` card is re-filed.
		expect(repo.getTask(db, taskId)).toMatchObject({
			column: "needs_attention",
			agentStatus: "stopped",
		});
	});

	it("files a running card like a PTY exit does, without marking it unread", () => {
		const s = addSession("claude", "a", "running");
		repo.updateTask(db, taskId, { column: "running", agentStatus: "running", isUnread: false });
		applyAgentQuit(db, allLive, s);
		expect(repo.getTask(db, taskId)).toMatchObject({
			column: "needs_attention",
			agentStatus: "stopped",
			isUnread: false,
		});
	});

	it("leaves the task alone while another of its agents is still at work", () => {
		const s = addSession("claude", "a", "idle");
		addSession("codex", "b", "running");
		addSession("shell", "c", "idle");
		repo.updateTask(db, taskId, { column: "running", agentStatus: "running" });
		applyAgentQuit(db, allLive, s);
		expect(repo.getSessionByTerminal(db, "a")?.status).toBe("stopped");
		expect(repo.getTask(db, taskId)).toMatchObject({ column: "running", agentStatus: "running" });
	});

	it("ignores an agent killed by a tab close or a reap: the PTY exit records those", () => {
		const s = addSession("claude", "a", "idle");
		repo.updateSession(db, s.id, { exitReason: "closed" });
		repo.updateTask(db, taskId, { column: "running", agentStatus: "running" });
		const closing = repo.getSessionByTerminal(db, "a");
		if (!closing) throw new Error("missing session");
		expect(applyAgentQuit(db, allLive, closing)).toBeNull();
		expect(repo.getSessionByTerminal(db, "a")?.status).toBe("idle");
		expect(repo.getTask(db, taskId)).toMatchObject({ column: "running", agentStatus: "running" });
	});

	it("makes the card draw the quit session as the shell it now is", () => {
		const s = addSession("claude", "a", "idle");
		applyAgentQuit(db, allLive, s);
		expect(liveAgentIds(db, allLive, taskId)).toEqual(["shell"]);
	});
});
