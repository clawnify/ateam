import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AteamDb, repo } from "@ateam/db";
import { gitFor } from "@ateam/git-core";
import { CH } from "@ateam/protocol";
// Reuse the db package's in-memory bun:sqlite test db (better-sqlite3 can't load
// under Bun). Cross-package test helper — the DRY source of a test AteamDb.
import { createTestDb } from "../../db/test/helpers/test-db";
// Same cross-package pattern: a real git repo, because createTask really runs git.
import { makeTempRepoPair } from "../../git-core/test/helpers/temp-repo";
import { createDispatcher } from "../src/dispatcher";
import type { Engine } from "../src/engine";

// A minimal fake Engine: a real in-memory db for the DB-backed handlers, stubs
// for the pieces those handlers don't touch, and a spy on taskUpdated so we can
// assert the extraction still emits it.
function makeEngine(db: AteamDb) {
	const taskUpdated: string[] = [];
	const spawned: { terminalId: string; args?: string[] }[] = [];
	const engine = {
		services: {
			db,
			pty: {
				has: () => false,
				kill() {},
				write() {},
				resize() {},
				spawn(o: { terminalId: string; args?: string[] }) {
					spawned.push(o);
				},
			},
			followUps: { arm() {}, discard() {} },
			pendingSeeds: new Map(),
			hooks: {},
			mergeQueue: {},
			loopRunner: { describe: () => [] },
			userDataDir: "/tmp",
			hooksDir: "/tmp/hooks",
			notifyScriptPath: "/tmp/notify.sh",
			hookPort: 0,
		},
		sendTaskUpdated: (id: string) => taskUpdated.push(id),
		sendLoopsUpdated: () => {},
	} as unknown as Engine;
	return { engine, taskUpdated, spawned };
}

describe("createDispatcher", () => {
	it("exposes engine methods but not the client-native ones", () => {
		const { engine } = makeEngine(createTestDb());
		const d = createDispatcher(engine);
		// Representative engine methods are routed…
		expect(d.methods).toContain(CH.tasksList);
		expect(d.methods).toContain(CH.gitCommit);
		expect(d.methods).toContain(CH.ptyWrite);
		// …and the Electron-only handlers are NOT (they live in the desktop shell).
		expect(d.methods).not.toContain(CH.projectsPick);
		expect(d.methods).not.toContain(CH.utilAttachImages);
		expect(d.methods).not.toContain(CH.utilAttachClipboardImage);
	});

	// Mission Control listens for taskUpdated rather than polling every task's
	// sessions, so a session that doesn't announce itself is invisible to other
	// windows and to the phone. The agent spawn always broadcast; the shell spawn
	// silently didn't.
	it("broadcasts taskUpdated when a shell session is spawned", async () => {
		const db = createTestDb();
		const { engine, taskUpdated } = makeEngine(db);
		const d = createDispatcher(engine);

		const project = repo.upsertProject(db, { repoPath: "/r/b", name: "B", defaultBranch: "main" });
		const task = repo.createTask(db, {
			projectId: project!.id,
			name: "open a shell",
			slug: "open-a-shell",
			branch: "open-a-shell",
			baseBranch: "main",
			worktreePath: "/r/b/.ateam/worktrees/open-a-shell",
		});

		const spawned = (await d.handle(CH.ptySpawnShell, [{ taskId: task.id }])) as {
			terminalId: string;
		};
		expect(spawned.terminalId).toBeTruthy();
		expect(taskUpdated).toContain(task.id);
	});

	// The card is created before its worktree finishes seeding, and it renders
	// `agentId ? <AgentIcon> : taskIcon(name)`. spawnAgentInTask only writes
	// agentId once seeding is done, so a null here is a keyword-guessed icon
	// (Sparkles / GitBranch) on screen that later flips to the real agent — a
	// flicker the user sees for the whole seed. The composer already knows the
	// answer, so the row carries it from the start.
	it("records the composer's agent on the task, so the card never guesses an icon", async () => {
		const tmp = await makeTempRepoPair();
		try {
			const db = createTestDb();
			const { engine } = makeEngine(db);
			const d = createDispatcher(engine);
			const project = repo.upsertProject(db, {
				repoPath: tmp.work,
				name: "seeded",
				defaultBranch: "main",
			});

			const task = (await d.handle(CH.tasksCreate, [
				{ projectId: project!.id, name: "look into the flake", agentId: "codex" },
			])) as { id: string; agentId: string | null };

			expect(task.agentId).toBe("codex");
			expect(repo.getTask(db, task.id)?.agentId).toBe("codex");
		} finally {
			await tmp.cleanup();
		}
	});

	// A task created without an explicit agent still stores null rather than a
	// guess — the icon falls back to the name-derived one, which is correct when
	// nothing has been chosen (e.g. a loop tick that picks its agent later).
	it("leaves agentId null when no agent was chosen", async () => {
		const tmp = await makeTempRepoPair();
		try {
			const db = createTestDb();
			const { engine } = makeEngine(db);
			const d = createDispatcher(engine);
			const project = repo.upsertProject(db, {
				repoPath: tmp.work,
				name: "unseeded",
				defaultBranch: "main",
			});

			const task = (await d.handle(CH.tasksCreate, [
				{ projectId: project!.id, name: "no agent yet" },
			])) as { agentId: string | null };

			expect(task.agentId).toBeNull();
		} finally {
			await tmp.cleanup();
		}
	});

	// The card must say "still preparing" while dependencies copy in, or the wait
	// is invisible and the app looks like it ignored the click — which is exactly
	// how this was reported. The flag is derived from the in-flight seed map and
	// never stored, so a crash mid-seed cannot strand a task as preparing.
	it("reports preparing while a seed is in flight, and not after", async () => {
		const db = createTestDb();
		const { engine } = makeEngine(db);
		const d = createDispatcher(engine);
		const project = repo.upsertProject(db, {
			repoPath: "/r/p",
			name: "P",
			defaultBranch: "main",
		});
		const task = repo.createTask(db, {
			projectId: project!.id,
			name: "seeding now",
			slug: "seeding-now",
			branch: "seeding-now",
			baseBranch: "main",
			worktreePath: "/r/p/.ateam/worktrees/seeding-now",
		});

		const seeds = engine.services.pendingSeeds;
		let release!: () => void;
		seeds.set(task.id, new Promise<void>((r) => { release = r; }));

		const during = (await d.handle(CH.tasksList, [project!.id])) as { preparing: boolean }[];
		expect(during[0]?.preparing).toBe(true);

		release();
		seeds.delete(task.id);

		const after = (await d.handle(CH.tasksList, [project!.id])) as { preparing: boolean }[];
		expect(after[0]?.preparing).toBe(false);
	});

	// --- tabs a restart took away ---------------------------------------------

	// The bug this exists for: a laptop restart kills the PTY daemon, and every
	// tab but one was simply gone. Restoring has to bring back the SAME
	// conversation, not the newest one in the worktree — which is all
	// `claude --continue` can reach, and all the app could do before.
	it("restores a stranded tab into a new terminal on the same conversation", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ateam-restore-"));
		try {
			const db = createTestDb();
			const { engine, spawned } = makeEngine(db);
			const d = createDispatcher(engine);
			const project = repo.upsertProject(db, { repoPath: dir, name: "R", defaultBranch: "main" });
			const task = repo.createTask(db, {
				projectId: project!.id,
				name: "restore me",
				slug: "restore-me",
				branch: "restore-me",
				baseBranch: "main",
				worktreePath: dir,
			});
			const dead = repo.createSession(db, {
				taskId: task.id,
				agentId: "claude",
				terminalId: "term-dead",
				agentSessionId: "conv-1",
				cwd: dir,
			});
			repo.updateSession(db, dead.id, { exitedAt: 1, exitReason: "stranded" });

			const listed = (await d.handle(CH.ptyListRestorable, [task.id])) as Array<{
				terminalId: string;
			}>;
			expect(listed.map((x) => x.terminalId)).toEqual(["term-dead"]);

			const back = (await d.handle(CH.ptyRestoreSession, [
				{ taskId: task.id, terminalId: "term-dead" },
			])) as { terminalId: string };

			// A new terminal, still pointed at the conversation the old tab held.
			expect(back.terminalId).not.toBe("term-dead");
			expect(repo.getSessionByTerminal(db, back.terminalId)?.agentSessionId).toBe("conv-1");
			expect(spawned.at(-1)?.args?.join(" ")).toContain("claude --resume 'conv-1'");
			// …and it is no longer offered, so it cannot be restored twice.
			expect(await d.handle(CH.ptyListRestorable, [task.id])).toEqual([]);
			expect(repo.getSessionByTerminal(db, "term-dead")?.exitReason).toBe("restored");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	// The other ending that owes the tab back: the app reclaimed an idle agent's
	// process to free memory. The user must not be able to tell the difference —
	// the same strip, the same conversation, resumed by id.
	it("restores a reaped tab into a new terminal on the same conversation", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ateam-reaped-"));
		try {
			const db = createTestDb();
			const { engine, spawned } = makeEngine(db);
			const d = createDispatcher(engine);
			const project = repo.upsertProject(db, { repoPath: dir, name: "R", defaultBranch: "main" });
			const task = repo.createTask(db, {
				projectId: project!.id,
				name: "reap me",
				slug: "reap-me",
				branch: "reap-me",
				baseBranch: "main",
				worktreePath: dir,
			});
			const reaped = repo.createSession(db, {
				taskId: task.id,
				agentId: "claude",
				terminalId: "term-reaped",
				agentSessionId: "conv-9",
				cwd: dir,
			});
			repo.updateSession(db, reaped.id, { exitedAt: 1, exitReason: "reaped" });

			const listed = (await d.handle(CH.ptyListRestorable, [task.id])) as Array<{
				terminalId: string;
			}>;
			expect(listed.map((x) => x.terminalId)).toEqual(["term-reaped"]);

			const back = (await d.handle(CH.ptyRestoreSession, [
				{ taskId: task.id, terminalId: "term-reaped" },
			])) as { terminalId: string };

			expect(back.terminalId).not.toBe("term-reaped");
			expect(spawned.at(-1)?.args?.join(" ")).toContain("claude --resume 'conv-9'");
			expect(await d.handle(CH.ptyListRestorable, [task.id])).toEqual([]);
			expect(repo.getSessionByTerminal(db, "term-reaped")?.exitReason).toBe("restored");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	// Two windows on the same task both auto-restore, or you double-click: the
	// conversation is already back, so hand over the tab it is in.
	it("hands back the existing tab when the conversation is already restored", async () => {
		const db = createTestDb();
		const { engine } = makeEngine(db);
		// This engine reports the second session as live.
		(engine.services as unknown as { pty: { has: (t: string) => boolean } }).pty.has = (t) =>
			t === "term-back";
		const d = createDispatcher(engine);
		const project = repo.upsertProject(db, { repoPath: "/r/e", name: "E" });
		const task = repo.createTask(db, {
			projectId: project!.id,
			name: "t",
			slug: "t",
			branch: "t",
			baseBranch: "main",
			worktreePath: "/r/e/wt",
		});
		const dead = repo.createSession(db, {
			taskId: task.id,
			agentId: "claude",
			terminalId: "term-dead",
			agentSessionId: "conv-1",
			cwd: "/r/e/wt",
		});
		repo.updateSession(db, dead.id, { exitedAt: 1, exitReason: "restored" });
		repo.createSession(db, {
			taskId: task.id,
			agentId: "claude",
			terminalId: "term-back",
			agentSessionId: "conv-1",
			cwd: "/r/e/wt",
		});

		expect(
			await d.handle(CH.ptyRestoreSession, [{ taskId: task.id, terminalId: "term-dead" }]),
		).toEqual({ terminalId: "term-back" });
	});

	it("refuses to restore a tab that was closed on purpose", async () => {
		const db = createTestDb();
		const { engine } = makeEngine(db);
		const d = createDispatcher(engine);
		const project = repo.upsertProject(db, { repoPath: "/r/c", name: "C" });
		const task = repo.createTask(db, {
			projectId: project!.id,
			name: "t",
			slug: "t",
			branch: "t",
			baseBranch: "main",
			worktreePath: "/r/c/wt",
		});
		const s = repo.createSession(db, {
			taskId: task.id,
			agentId: "claude",
			terminalId: "term-closed",
			cwd: "/r/c/wt",
		});
		repo.updateSession(db, s.id, { exitedAt: 1, exitReason: "closed" });

		expect(
			d.handle(CH.ptyRestoreSession, [{ taskId: task.id, terminalId: "term-closed" }]),
		).rejects.toThrow(/not restorable/);
	});

	// Closing a tab is the one ending that means "I am done with this". The
	// engine reads this stamp back instead of guessing why a PTY went away.
	it("marks a killed session closed, so a restart cannot offer it back", async () => {
		const db = createTestDb();
		const { engine } = makeEngine(db);
		const d = createDispatcher(engine);
		const project = repo.upsertProject(db, { repoPath: "/r/d", name: "D" });
		const task = repo.createTask(db, {
			projectId: project!.id,
			name: "t",
			slug: "t",
			branch: "t",
			baseBranch: "main",
			worktreePath: "/r/d/wt",
		});
		repo.createSession(db, {
			taskId: task.id,
			agentId: "claude",
			terminalId: "term-1",
			cwd: "/r/d/wt",
		});

		await d.handle(CH.ptyKill, ["term-1"]);
		expect(repo.getSessionByTerminal(db, "term-1")?.exitReason).toBe("closed");
	});

	it("throws on an unknown method", () => {
		const { engine } = makeEngine(createTestDb());
		const d = createDispatcher(engine);
		expect(d.handle("does:not-exist", [])).rejects.toThrow(/Unknown method/);
	});

	it("lists tasks and moves a card, emitting taskUpdated", async () => {
		const db = createTestDb();
		const { engine, taskUpdated } = makeEngine(db);
		const d = createDispatcher(engine);

		const project = repo.upsertProject(db, { repoPath: "/r/a", name: "A", defaultBranch: "main" });
		const task = repo.createTask(db, {
			projectId: project!.id,
			name: "do a thing",
			slug: "do-a-thing",
			branch: "do-a-thing",
			baseBranch: "main",
			worktreePath: "/r/a/.ateam/worktrees/do-a-thing",
		});

		const listed = (await d.handle(CH.tasksList, [project!.id])) as Array<{ id: string }>;
		expect(listed.map((t) => t.id)).toEqual([task.id]);

		const moved = (await d.handle(CH.tasksSetColumn, [task.id, "review"])) as { column: string };
		expect(moved.column).toBe("review");
		// The extracted handler must still broadcast the move.
		expect(taskUpdated).toContain(task.id);
		// …and it persisted.
		expect(repo.getTask(db, task.id)?.column).toBe("review");
	});

	it("registers no project rows for an empty db", async () => {
		const { engine } = makeEngine(createTestDb());
		const d = createDispatcher(engine);
		expect(await d.handle(CH.projectsList, [])).toEqual([]);
	});

	// The phone's "New project" git-inits an empty folder and registers it BEFORE
	// anything is cloned into it, so the row is born with no GitHub identity — and
	// that identity is the only thing that merges this repo's copies across engines
	// into one board card. Listing must repair it, or the board shows the repo twice
	// forever. Repairing must NOT reorder the sidebar, which sorts on lastOpenedAt.
	it("repairs a project's GitHub identity on list without touching lastOpenedAt", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ateam-identity-"));
		try {
			const db = createTestDb();
			const { engine } = makeEngine(db);
			const d = createDispatcher(engine);

			const older = (await d.handle(CH.projectsRegister, [join(dir, "older"), { init: true }])) as {
				id: string;
			};
			const project = (await d.handle(CH.projectsRegister, [
				join(dir, "repo"),
				{ init: true },
			])) as { id: string; githubOwner: string | null };
			// Born identity-less: `git init` alone has no origin to read one from.
			expect(project.githubOwner).toBeNull();
			const openedAt = repo.getProject(db, project.id)?.lastOpenedAt;

			// …and now the repo is cloned in, which is when origin appears.
			await gitFor(join(dir, "repo")).addRemote(
				"origin",
				"https://github.com/Clawnify/TaskWindow.git",
			);

			const listed = (await d.handle(CH.projectsList, [])) as Array<{
				id: string;
				githubOwner: string | null;
				githubName: string | null;
			}>;
			const healed = listed.find((p) => p.id === project.id);
			expect(healed?.githubOwner).toBe("Clawnify");
			expect(healed?.githubName).toBe("TaskWindow");
			// Persisted, so every later list agrees…
			expect(repo.getProject(db, project.id)?.githubName).toBe("TaskWindow");
			// …and the repair is invisible to the sidebar's ordering.
			expect(repo.getProject(db, project.id)?.lastOpenedAt).toBe(openedAt!);
			expect(listed.map((p) => p.id)).toEqual([project.id, older.id]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	// Cleanup used to hide everything its rule rejected, so an unmerged or busy
	// worktree was simply not offered. The list is now the whole project and the
	// rule only advises — that is the difference this asserts.
	it("offers every task for cleanup, flagging only the sweep-safe ones", async () => {
		const db = createTestDb();
		const { engine } = makeEngine(db);
		// One live terminal, so "merged but the agent is still in it" is real.
		(engine.services.pty as unknown as { has: (id: string) => boolean }).has = (id) =>
			id === "live-term";
		const d = createDispatcher(engine);

		const project = repo.upsertProject(db, { repoPath: "/r/c", name: "C", defaultBranch: "main" });
		const mk = (name: string) =>
			repo.createTask(db, {
				projectId: project!.id,
				name,
				slug: name,
				branch: name,
				baseBranch: "main",
				// Nonexistent path: the git probe is guarded and reads a vanished
				// worktree as clean, which is the behaviour we want asserted here.
				worktreePath: `/r/c/.ateam/worktrees/${name}`,
			});

		const ongoing = mk("ongoing"); // todo, no PR → not merged
		const swept = mk("swept");
		repo.updateTask(db, swept.id, { column: "merged", prNumber: 7, prState: "merged" });
		const busy = mk("busy");
		repo.updateTask(db, busy.id, { column: "merged", prState: "merged" });
		repo.createSession(db, {
			taskId: busy.id,
			agentId: "claude",
			terminalId: "live-term",
			cwd: "/r/c",
		});

		const list = (await d.handle(CH.tasksCleanupCandidates, [project!.id])) as Array<{
			task: { id: string; prState: string | null; prNumber: number | null };
			recommended: boolean;
			reason: string;
			terminalId: string | null;
		}>;

		// Every task is listed — nothing is filtered out of the decision any more.
		expect(list.map((c) => c.task.id).sort()).toEqual([ongoing.id, swept.id, busy.id].sort());

		const by = (id: string) => list.find((c) => c.task.id === id)!;
		expect(by(swept.id).recommended).toBe(true);
		expect(by(ongoing.id)).toMatchObject({ recommended: false, reason: "not merged" });
		expect(by(busy.id)).toMatchObject({ recommended: false, reason: "agent still active" });
		// The live PTY rides along so the dialog can show the conversation.
		expect(by(busy.id).terminalId).toBe("live-term");
		expect(by(ongoing.id).terminalId).toBeNull();
		// The factors the user decides on come from the task itself.
		expect(by(swept.id).task.prNumber).toBe(7);
		expect(by(swept.id).task.prState).toBe("merged");
	});

	// A brand-new project from a client with no native folder dialog (the phone): the
	// folder doesn't exist yet, so register+init must create it before git-initing.
	it("creates the folder and inits a repo when registering a brand-new project", async () => {
		const { engine } = makeEngine(createTestDb());
		const d = createDispatcher(engine);
		const base = await mkdtemp(join(tmpdir(), "ateam-newproj-"));
		const path = join(base, "fresh-project"); // does not exist yet
		expect(existsSync(path)).toBe(false);
		try {
			const project = (await d.handle(CH.projectsRegister, [path, { init: true }])) as {
				name: string;
			};
			expect(existsSync(join(path, ".git"))).toBe(true); // created AND git-inited
			expect(project.name).toBe("fresh-project");
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});
});
