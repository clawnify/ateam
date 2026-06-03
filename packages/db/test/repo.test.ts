import { beforeEach, describe, expect, it } from "bun:test";
import { type GroveDb, repo } from "../src/index";
import { createTestDb } from "./helpers/test-db";

let db: GroveDb;
beforeEach(() => {
	db = createTestDb();
});

describe("projects", () => {
	it("upserts (insert then update by repoPath) and lists", () => {
		const a = repo.upsertProject(db, {
			repoPath: "/r/a",
			name: "A",
			defaultBranch: "main",
		});
		expect(a?.id).toBeString();

		const again = repo.upsertProject(db, { repoPath: "/r/a", name: "A renamed" });
		expect(again?.id).toBe(a?.id); // same row
		expect(again?.name).toBe("A renamed");

		repo.upsertProject(db, { repoPath: "/r/b", name: "B" });
		expect(repo.listProjects(db).length).toBe(2);
	});
});

describe("tasks", () => {
	it("creates, lists by project, updates column, and deletes", () => {
		const p = repo.upsertProject(db, { repoPath: "/r/a", name: "A" });
		const t = repo.createTask(db, {
			projectId: p!.id,
			name: "Add auth",
			slug: "add-auth",
			branch: "add-auth",
			baseBranch: "main",
			worktreePath: "/r/a/.worktrees/add-auth",
		});
		expect(t.column).toBe("todo");

		const updated = repo.updateTask(db, t.id, { column: "running" });
		expect(updated?.column).toBe("running");

		expect(repo.listTasks(db, p!.id).length).toBe(1);
		repo.deleteTask(db, t.id);
		expect(repo.listTasks(db, p!.id).length).toBe(0);
	});

	it("cascades task deletion when project is removed", () => {
		const p = repo.upsertProject(db, { repoPath: "/r/a", name: "A" });
		repo.createTask(db, {
			projectId: p!.id,
			name: "t",
			slug: "t",
			branch: "t",
			baseBranch: "main",
			worktreePath: "/wt/t",
		});
		repo.deleteProject(db, p!.id);
		expect(repo.listTasks(db, p!.id).length).toBe(0);
	});
});

describe("agent sessions & events", () => {
	it("creates a session, looks it up by terminalId, records an event", () => {
		const p = repo.upsertProject(db, { repoPath: "/r/a", name: "A" });
		const t = repo.createTask(db, {
			projectId: p!.id,
			name: "t",
			slug: "t",
			branch: "t",
			baseBranch: "main",
			worktreePath: "/wt/t",
		});
		const s = repo.createSession(db, {
			taskId: t.id,
			agentId: "claude",
			terminalId: "term-1",
			cwd: "/wt/t",
		});
		expect(repo.getSessionByTerminal(db, "term-1")?.id).toBe(s.id);

		repo.updateSession(db, s.id, { status: "running" });
		expect(repo.getSessionByTerminal(db, "term-1")?.status).toBe("running");

		const e = repo.recordEvent(db, {
			sessionId: s.id,
			terminalId: "term-1",
			eventType: "Stop",
		});
		expect(e.eventType).toBe("Stop");
	});
});

describe("settings", () => {
	it("returns a single row and updates it", () => {
		const s = repo.getSettings(db);
		expect(s.id).toBe(1);
		expect(s.defaultMergeStrategy).toBe("squash");

		const updated = repo.updateSettings(db, { defaultAgentId: "opencode" });
		expect(updated.defaultAgentId).toBe("opencode");
	});
});
