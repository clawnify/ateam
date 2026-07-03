import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { type AteamDb, bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../../packages/db/src/schema";
import { applySetStatus } from "../src/main/loops/board-signals";

function createTestDb(): AteamDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	bootstrap(sqlite);
	return drizzle(sqlite, { schema }) as unknown as AteamDb;
}

function makeTask(db: AteamDb, column: schema.KanbanColumn) {
	const project = repo.upsertProject(db, { repoPath: "/tmp/repo", name: "repo" });
	return repo.createTask(db, {
		projectId: project.id,
		name: "a task",
		slug: "a-task",
		branch: "feat/a",
		baseBranch: "main",
		worktreePath: "/tmp/repo/.ateam/worktrees/a",
		column,
	});
}

let db: AteamDb;
let updated: string[];
const onUpdated = (id: string) => updated.push(id);

beforeEach(() => {
	db = createTestDb();
	updated = [];
});

describe("applySetStatus — endpoint integration (guardrail + audit + db)", () => {
	it("applies a legal move, updates the card, writes one audit row, notifies", () => {
		const t = makeTask(db, "todo");
		const r = applySetStatus(db, { taskId: t.id, to: "review", reason: "PR open" }, onUpdated);
		expect(r.ok).toBe(true);
		expect(repo.getTask(db, t.id)?.column).toBe("review");
		const audit = repo.listBoardChanges(db, { taskId: t.id });
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({ fromColumn: "todo", toColumn: "review", reason: "PR open" });
		expect(updated).toEqual([t.id]);
	});

	it("refuses a ground-truth target and leaves the card + audit untouched", () => {
		const t = makeTask(db, "todo");
		const r = applySetStatus(db, { taskId: t.id, to: "running" }, onUpdated);
		expect(r.ok).toBe(false);
		expect(repo.getTask(db, t.id)?.column).toBe("todo");
		expect(repo.listBoardChanges(db, { taskId: t.id })).toHaveLength(0);
		expect(updated).toEqual([]);
	});

	it("the organizer never moves a card that has a live agent", () => {
		const t = makeTask(db, "review");
		// A session whose pid is this test process — guaranteed alive.
		repo.createSession(db, {
			taskId: t.id,
			agentId: "claude",
			terminalId: "term-1",
			cwd: t.worktreePath,
			pid: process.pid,
		});
		// No callerTerminalId → organizer; live agent → refused.
		const r = applySetStatus(db, { taskId: t.id, to: "todo" }, onUpdated);
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("live agent");
		expect(repo.getTask(db, t.id)?.column).toBe("review");
	});

	it("rejects an unknown task", () => {
		const r = applySetStatus(db, { taskId: "nope", to: "review" }, onUpdated);
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("unknown task");
	});

	it("lets a session move its OWN live card (self-move), audited as source=session", () => {
		const t = makeTask(db, "running");
		repo.createSession(db, {
			taskId: t.id,
			agentId: "claude",
			terminalId: "term-self",
			cwd: t.worktreePath,
			pid: process.pid, // alive
		});
		const r = applySetStatus(
			db,
			{ taskId: t.id, to: "review", reason: "done", callerTerminalId: "term-self" },
			onUpdated,
		);
		expect(r.ok).toBe(true);
		expect(repo.getTask(db, t.id)?.column).toBe("review");
		expect(repo.listBoardChanges(db, { taskId: t.id })[0].source).toBe("session");
	});

	it("forbids a session from moving a DIFFERENT task", () => {
		const mine = makeTask(db, "running");
		const other = repo.createTask(db, {
			projectId: mine.projectId,
			name: "other",
			slug: "other",
			branch: "feat/b",
			baseBranch: "main",
			worktreePath: "/tmp/repo/.ateam/worktrees/b",
			column: "todo",
		});
		repo.createSession(db, {
			taskId: mine.id,
			agentId: "claude",
			terminalId: "term-mine",
			cwd: mine.worktreePath,
			pid: process.pid,
		});
		const r = applySetStatus(
			db,
			{ taskId: other.id, to: "review", callerTerminalId: "term-mine" },
			onUpdated,
		);
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("only change its own task");
	});

	it("defaults the audit reason when the organizer gives none", () => {
		const t = makeTask(db, "todo");
		applySetStatus(db, { taskId: t.id, to: "review" }, onUpdated);
		expect(repo.listBoardChanges(db, { taskId: t.id })[0].reason).toBe("organizer re-triage");
	});
});
