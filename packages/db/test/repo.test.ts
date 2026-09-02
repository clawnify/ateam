import { beforeEach, describe, expect, it } from "bun:test";
import { type AteamDb, repo } from "../src/index";
import { createTestDb } from "./helpers/test-db";

let db: AteamDb;
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

	it("lists a task's sessions latest-first", () => {
		const p = repo.upsertProject(db, { repoPath: "/r/a", name: "A" });
		const t = repo.createTask(db, {
			projectId: p!.id,
			name: "t",
			slug: "t",
			branch: "t",
			baseBranch: "main",
			worktreePath: "/wt/t",
		});
		const older = repo.createSession(db, {
			taskId: t.id,
			agentId: "claude",
			terminalId: "term-old",
			cwd: "/wt/t",
		});
		const newer = repo.createSession(db, {
			taskId: t.id,
			agentId: "claude",
			terminalId: "term-new",
			cwd: "/wt/t",
		});
		repo.updateSession(db, older.id, { startedAt: 1000 });
		repo.updateSession(db, newer.id, { startedAt: 2000 });

		expect(repo.listSessionsByTask(db, t.id).map((s) => s.id)).toEqual([
			newer.id,
			older.id,
		]);
	});

	it("lists open sessions across projects, excluding exited ones", () => {
		const a = repo.upsertProject(db, { repoPath: "/r/a", name: "A" });
		const b = repo.upsertProject(db, { repoPath: "/r/b", name: "B" });
		const mkTask = (projectId: string, slug: string) =>
			repo.createTask(db, {
				projectId,
				name: slug,
				slug,
				branch: slug,
				baseBranch: "main",
				worktreePath: `/wt/${slug}`,
			});
		const ta = mkTask(a!.id, "ta");
		const tb = mkTask(b!.id, "tb");
		const open = repo.createSession(db, {
			taskId: ta.id,
			agentId: "claude",
			terminalId: "term-open",
			cwd: "/wt/ta",
		});
		const exited = repo.createSession(db, {
			taskId: tb.id,
			agentId: "claude",
			terminalId: "term-exited",
			cwd: "/wt/tb",
		});
		repo.updateSession(db, exited.id, { exitedAt: Date.now() });

		expect(repo.listOpenSessions(db).map((s) => s.id)).toEqual([open.id]);
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

describe("restorable sessions", () => {
	function task() {
		const p = repo.upsertProject(db, { repoPath: "/r/a", name: "A" });
		return repo.createTask(db, {
			projectId: p!.id,
			name: "t",
			slug: "t",
			branch: "t",
			baseBranch: "main",
			worktreePath: "/wt/t",
		});
	}

	// The distinction the whole restore rests on: a tab you closed stays closed,
	// a tab a restart took away comes back.
	it("offers only the sessions that were open when the app went down", () => {
		const t = task();
		const mk = (terminalId: string, exitReason: "closed" | "exited" | "stranded" | null) => {
			const s = repo.createSession(db, {
				taskId: t.id,
				agentId: "claude",
				terminalId,
				agentSessionId: terminalId,
				cwd: "/wt/t",
			});
			if (exitReason) repo.updateSession(db, s.id, { exitedAt: 1, exitReason });
			return s;
		};
		mk("term-live", null);
		mk("term-closed", "closed");
		mk("term-exited", "exited");
		const stranded = mk("term-stranded", "stranded");

		expect(repo.listRestorableSessions(db, t.id).map((s) => s.id)).toEqual([stranded.id]);
	});

	// Sessions predating the column carry no claim about how they ended, so a db
	// full of history does not turn into a strip full of ghosts on first launch.
	it("does not offer sessions that predate the exit_reason column", () => {
		const t = task();
		const s = repo.createSession(db, {
			taskId: t.id,
			agentId: "claude",
			terminalId: "term-old",
			cwd: "/wt/t",
		});
		repo.updateSession(db, s.id, { exitedAt: 1 });
		expect(repo.listRestorableSessions(db, t.id)).toEqual([]);
	});

	// A reap is deliberate, so unlike a strand it survives the once-per-run
	// retirement: the app took the process on purpose and owes the tab back.
	it("offers a reaped tab, and still offers it after the next app run", () => {
		const t = task();
		const s = repo.createSession(db, {
			taskId: t.id,
			agentId: "claude",
			terminalId: "term-reaped",
			agentSessionId: "conv-1",
			cwd: "/wt/t",
		});
		repo.updateSession(db, s.id, { exitedAt: 1, exitReason: "reaped" });

		expect(repo.listRestorableSessions(db, t.id).map((x) => x.id)).toEqual([s.id]);

		repo.demoteStrandedSessions(db);

		expect(repo.listRestorableSessions(db, t.id).map((x) => x.id)).toEqual([s.id]);
	});

	// A task holds one live session at a time, so reap after reap on a task the
	// user never comes back to must not grow a strip of dead tabs.
	it("supersedes a task's earlier reaped tab with the newest one", () => {
		const t = task();
		const mk = (terminalId: string) => {
			const s = repo.createSession(db, {
				taskId: t.id,
				agentId: "claude",
				terminalId,
				agentSessionId: terminalId,
				cwd: "/wt/t",
			});
			repo.updateSession(db, s.id, { exitedAt: 1, exitReason: "reaped" });
			return s;
		};
		const first = mk("term-1");

		repo.demoteReapedSessions(db, t.id);
		const second = mk("term-2");

		expect(repo.listRestorableSessions(db, t.id).map((x) => x.id)).toEqual([second.id]);
		expect(repo.getSessionByTerminal(db, "term-1")?.exitReason).toBe("exited");
		expect(first.id).not.toBe(second.id);
	});

	// Without this, every run of the app would leave its own layer of tabs behind.
	it("retires the previous run's stranded tabs to plain history", () => {
		const t = task();
		const s = repo.createSession(db, {
			taskId: t.id,
			agentId: "claude",
			terminalId: "term-1",
			cwd: "/wt/t",
		});
		repo.updateSession(db, s.id, { exitedAt: 1, exitReason: "stranded" });

		repo.demoteStrandedSessions(db);

		expect(repo.listRestorableSessions(db, t.id)).toEqual([]);
		expect(repo.getSessionByTerminal(db, "term-1")?.exitReason).toBe("exited");
	});

	// A conversation carried into a new tab must resolve to the tab it lives in
	// NOW — this is the lookup session search uses to open a result.
	it("finds the newest terminal a conversation is running on", () => {
		const t = task();
		const first = repo.createSession(db, {
			taskId: t.id,
			agentId: "claude",
			terminalId: "term-1",
			agentSessionId: "conv-1",
			cwd: "/wt/t",
		});
		const second = repo.createSession(db, {
			taskId: t.id,
			agentId: "claude",
			terminalId: "term-2",
			agentSessionId: "conv-1",
			cwd: "/wt/t",
		});
		repo.updateSession(db, first.id, { startedAt: 1000 });
		repo.updateSession(db, second.id, { startedAt: 2000 });

		expect(repo.findTerminalByAgentSessionId(db, "conv-1")).toBe("term-2");
		expect(repo.findTerminalByAgentSessionId(db, "nope")).toBeUndefined();
	});
});
