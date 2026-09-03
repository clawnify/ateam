import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { AteamDb } from "@ateam/db";
import { bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import { LoopRunner } from "../src/loops/runner";
import type { LoopDefinition } from "../src/loops/types";

function createTestDb(): AteamDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	bootstrap(sqlite);
	return drizzle(sqlite, { schema }) as unknown as AteamDb;
}

/** A self-paced def with cadence long enough that no background timer fires
 *  during the test — every run is driven explicitly through `runNow`. */
function makeDef(id: string, run: LoopDefinition["run"]): LoopDefinition {
	return {
		id,
		title: `Loop ${id}`,
		description: "test loop",
		scope: "global",
		cadence: { mode: "self_paced", minMs: 60_000, maxMs: 120_000 },
		run,
	};
}

let db: AteamDb;

/** Everything the fake session layer records, for assertions. */
interface SessionLog {
	created: { projectId: string; name: string }[];
	spawned: { taskId: string; agentId: string; prompt: string }[];
	stopped: string[];
	/** Task names that make the fake createTask throw (branch-collision sim). */
	failNames: Set<string>;
	liveTasks: Set<string>;
}

function makeLog(): SessionLog {
	return { created: [], spawned: [], stopped: [], failNames: new Set(), liveTasks: new Set() };
}

/** Fake session ops: record calls and create real task rows, so the
 *  agent-session template's liveness/link checks see real state. */
function makeRunner(log: SessionLog = makeLog(), onChanged?: () => void): LoopRunner {
	return new LoopRunner({
		db,
		onChanged,
		sessions: {
			createTask: async (input) => {
				if (log.failNames.has(input.name)) throw new Error(`branch exists: ${input.name}`);
				log.created.push(input);
				const task = repo.createTask(db, {
					projectId: input.projectId,
					name: input.name,
					slug: `t-${log.created.length}`,
					branch: `loop/t-${log.created.length}`,
					baseBranch: "main",
					worktreePath: `/tmp/loop-t-${log.created.length}`,
				});
				return { taskId: task.id };
			},
			spawnAgent: async (input) => {
				log.spawned.push(input);
				const terminalId = `term-${log.spawned.length}`;
				// Mirror spawnAgentInTask: a launch records a session row, which is
				// what the template's liveness check reads.
				repo.createSession(db, {
					taskId: input.taskId,
					agentId: input.agentId,
					terminalId,
					cwd: `/tmp/${input.taskId}`,
				});
				return { terminalId };
			},
			stopTaskSessions: (taskId) => {
				log.stopped.push(taskId);
			},
			isTaskAgentLive: (taskId) => log.liveTasks.has(taskId),
		},
	});
}

function seedProject(): string {
	const p = repo.upsertProject(db, {
		repoPath: "/tmp/repo",
		name: "Repo",
		defaultBranch: "main",
	});
	if (!p) throw new Error("failed to seed project");
	return p.id;
}

beforeEach(() => {
	db = createTestDb();
});

describe("LoopRunner", () => {
	it("instantiates a registered loop and lists it as enabled", () => {
		const runner = makeRunner();
		runner.register(makeDef("a", async () => ({ summary: "ok" })));
		runner.start();

		const loops = runner.describe();
		expect(loops).toHaveLength(1);
		expect(loops[0]).toMatchObject({ id: "a", enabled: true, runs: 0 });
		runner.stop();
	});

	it("runNow executes the run and records telemetry", async () => {
		let calls = 0;
		const runner = makeRunner();
		runner.register(
			makeDef("a", async () => {
				calls++;
				return { summary: `run ${calls}` };
			}),
		);
		runner.start();

		await runner.runNow("a");
		expect(calls).toBe(1);
		const [loop] = runner.describe();
		expect(loop.lastStatus).toBe("ok");
		expect(loop.lastSummary).toBe("run 1");
		expect(loop.runs).toBe(1);
		expect(loop.lastRunAt).toBeGreaterThan(0);
		runner.stop();
	});

	it("records an error when a run throws, and keeps the loop", async () => {
		const runner = makeRunner();
		runner.register(
			makeDef("a", async () => {
				throw new Error("boom");
			}),
		);
		runner.start();

		await runner.runNow("a");
		const [loop] = runner.describe();
		expect(loop.lastStatus).toBe("error");
		expect(loop.lastError).toBe("boom");
		expect(runner.describe()).toHaveLength(1); // still scheduled
		runner.stop();
	});

	it("setEnabled toggles the persisted flag", () => {
		const runner = makeRunner();
		runner.register(makeDef("a", async () => ({})));
		runner.start();

		runner.setEnabled("a", false);
		expect(runner.describe()[0].enabled).toBe(false);
		expect(repo.getLoop(db, "a")?.enabled).toBe(false);

		runner.setEnabled("a", true);
		expect(runner.describe()[0].enabled).toBe(true);
		runner.stop();
	});

	it("removes a loop that reports done", async () => {
		const runner = makeRunner();
		runner.register(makeDef("a", async () => ({ summary: "fin", done: true })));
		runner.start();

		await runner.runNow("a");
		expect(runner.describe()).toHaveLength(0);
		expect(repo.getLoop(db, "a")).toBeUndefined();
		runner.stop();
	});

	it("persists enabled state across runner restarts", () => {
		const first = makeRunner();
		first.register(makeDef("a", async () => ({})));
		first.start();
		first.setEnabled("a", false);
		first.stop();

		const second = makeRunner();
		second.register(makeDef("a", async () => ({})));
		second.start();
		// The disabled flag from the prior run survives (row was persisted).
		expect(second.describe()[0].enabled).toBe(false);
		second.stop();
	});

	it("prunes builtin rows from earlier versions when nothing registers them", () => {
		repo.ensureLoop(db, {
			id: "board-reconciler",
			definitionId: "board-reconciler",
			scopeKey: null,
			enabled: true,
		});
		const runner = makeRunner();
		runner.start();
		expect(runner.describe()).toHaveLength(0);
		expect(repo.getLoop(db, "board-reconciler")).toBeUndefined();
		runner.stop();
	});

	it("creates a user loop from a template and persists it across restarts", () => {
		const projectId = seedProject();
		const runner = makeRunner();
		runner.start();

		const loops = runner.createUserLoop({
			templateId: "agent-session",
			name: "Nightly deps",
			projectId,
			config: { prompt: "update deps", agentId: "claude" },
			intervalMs: 3_600_000,
			cadenceMode: "fixed",
		});
		const created = loops.find((l) => l.kind === "user");
		expect(created).toBeDefined();
		expect(created?.title).toBe("Nightly deps");
		expect(created?.templateId).toBe("agent-session");
		expect(created?.prompt).toBe("update deps");
		expect(created?.agentId).toBe("claude");
		expect(created?.intervalMs).toBe(3_600_000);
		expect(created?.enabled).toBe(true);
		runner.stop();

		// A fresh runner rebuilds the user loop from its persisted row.
		const restarted = makeRunner();
		restarted.start();
		const again = restarted.describe().find((l) => l.kind === "user");
		expect(again?.title).toBe("Nightly deps");
		expect(again?.templateId).toBe("agent-session");
		restarted.stop();
	});

	it("rejects an unknown template", () => {
		const runner = makeRunner();
		runner.start();
		expect(() => runner.createUserLoop({ templateId: "nope", name: "x" })).toThrow(
			/Unknown loop template/,
		);
		runner.stop();
	});

	it("updates a user loop in place, preserving the task link", async () => {
		const projectId = seedProject();
		const log = makeLog();
		const runner = makeRunner(log);
		runner.start();
		const id = runner
			.createUserLoop({
				templateId: "agent-session",
				name: "Nightly deps",
				projectId,
				config: { prompt: "update deps", agentId: "claude" },
				intervalMs: 3_600_000,
				cadenceMode: "fixed",
			})
			.find((l) => l.kind === "user")?.id as string;

		// A run records the persistent task into the config…
		await runner.runNow(id);
		const taskId = repo.getLoop(db, id)?.config?.taskId as string;
		expect(taskId).toBeTruthy();

		// …which an edit must not wipe.
		const loops = runner.updateUserLoop({
			id,
			name: "Weekly deps",
			intervalMs: 7_200_000,
			config: { prompt: "update deps weekly", agentId: "codex" },
		});
		const updated = loops.find((l) => l.id === id);
		expect(updated).toMatchObject({
			title: "Weekly deps",
			prompt: "update deps weekly",
			agentId: "codex",
			intervalMs: 7_200_000,
			taskId,
		});

		// The next run uses the new prompt/agent, in the same task.
		await runner.runNow(id);
		expect(log.spawned[1]).toMatchObject({
			prompt: expect.stringContaining("update deps weekly"),
			agentId: "codex",
			taskId,
		});
		runner.stop();
	});

	it("rejects updating an unknown loop", () => {
		const runner = makeRunner();
		runner.start();
		expect(() => runner.updateUserLoop({ id: "nope", name: "x" })).toThrow(/Loop not found/);
		runner.stop();
	});

	it("deletes a user loop and its row", () => {
		const projectId = seedProject();
		const runner = makeRunner();
		runner.start();
		const loops = runner.createUserLoop({
			templateId: "agent-session",
			name: "Nightly deps",
			projectId,
			config: { prompt: "update deps" },
		});
		const id = loops.find((l) => l.kind === "user")?.id as string;
		expect(id).toBeTruthy();

		const after = runner.deleteUserLoop(id);
		expect(after.find((l) => l.id === id)).toBeUndefined();
		expect(repo.getLoop(db, id)).toBeUndefined();
		runner.stop();
	});

	describe("agent-session template", () => {
		function seedLoop(runner: LoopRunner, projectId: string, name = "Nightly deps"): string {
			return runner
				.createUserLoop({
					templateId: "agent-session",
					name,
					projectId,
					config: { prompt: "update deps", agentId: "codex" },
				})
				.find((l) => l.kind === "user")?.id as string;
		}

		it("owns one persistent task: first run creates it, later runs reuse it", async () => {
			const projectId = seedProject();
			const log = makeLog();
			const runner = makeRunner(log);
			runner.start();
			const id = seedLoop(runner, projectId);

			await runner.runNow(id);
			expect(log.created).toHaveLength(1);
			expect(log.created[0]).toMatchObject({ projectId, name: "Nightly deps" });
			const taskId = repo.getLoop(db, id)?.config?.taskId as string;
			expect(log.spawned[0]).toMatchObject({
				taskId,
				agentId: "codex",
				prompt: expect.stringContaining("update deps"),
			});

			// Previous run finished → the next tick reuses the SAME task: no new
			// task, previous pane closed, fresh session spawned in place.
			repo.updateTask(db, taskId, { agentStatus: "stopped" });
			await runner.runNow(id);
			expect(log.created).toHaveLength(1);
			expect(log.stopped).toEqual([taskId]);
			expect(log.spawned).toHaveLength(2);
			expect(log.spawned[1]?.taskId).toBe(taskId);
			runner.stop();
		});

		it("notifies after a scheduled tick, with the task link already in the DTO", async () => {
			const projectId = seedProject();
			const log = makeLog();
			// What the engine pushes on each notification — the UI filters the
			// loop's task out of its TASKS list by this taskId, so a notification
			// that arrives without it would leave the loop's card sitting there.
			const pushed: (string | null)[] = [];
			let runner!: LoopRunner;
			runner = makeRunner(log, () => {
				pushed.push(runner.describe().find((l) => l.kind === "user")?.taskId ?? null);
			});
			runner.start();
			const id = seedLoop(runner, projectId);

			await runner.runNow(id, { manual: false });
			const taskId = repo.getLoop(db, id)?.config?.taskId as string;
			expect(taskId).toBeTruthy();
			expect(pushed).toEqual([taskId]);
			runner.stop();
		});

		it("adopts a pre-persistent-era lastTaskId as the loop's task", async () => {
			const projectId = seedProject();
			const log = makeLog();
			const runner = makeRunner(log);
			runner.start();
			const id = seedLoop(runner, projectId);
			// Simulate a loop that ran under the old fresh-task-per-run model.
			const old = repo.createTask(db, {
				projectId,
				name: "Nightly deps #7",
				slug: "old-run",
				branch: "old-run",
				baseBranch: "main",
				worktreePath: "/tmp/old-run",
			});
			const row = repo.getLoop(db, id);
			repo.updateLoop(db, id, { config: { ...row?.config, lastTaskId: old.id } });

			await runner.runNow(id);
			expect(log.created).toHaveLength(0); // reused, not recreated
			expect(log.spawned[0]?.taskId).toBe(old.id);
			expect(repo.getLoop(db, id)?.config?.taskId).toBe(old.id);
			expect(repo.getLoop(db, id)?.config?.lastTaskId).toBeUndefined();
			runner.stop();
		});

		it("recreates the task when it was cleaned up, with a collision fallback", async () => {
			const projectId = seedProject();
			const log = makeLog();
			const runner = makeRunner(log);
			runner.start();
			const id = seedLoop(runner, projectId);

			await runner.runNow(id);
			const firstTaskId = repo.getLoop(db, id)?.config?.taskId as string;
			// The task is removed (cleanup), and its branch lingers so the plain
			// name collides — the loop must fall back to a suffixed name.
			repo.deleteTask(db, firstTaskId);
			log.failNames.add("Nightly deps");
			await runner.runNow(id);
			expect(log.created[1]?.name).toBe("Nightly deps 2");
			expect(repo.getLoop(db, id)?.config?.taskId).not.toBe(firstTaskId);
			runner.stop();
		});

		it("skips a tick while the previous run's agent is still working", async () => {
			const projectId = seedProject();
			const log = makeLog();
			const runner = makeRunner(log);
			runner.start();
			const id = seedLoop(runner, projectId);

			await runner.runNow(id);
			expect(log.spawned).toHaveLength(1);
			// The agent is still running (live PTY) → the next tick must not stack.
			const taskId = repo.getLoop(db, id)?.config?.taskId as string;
			repo.updateTask(db, taskId, { agentStatus: "running" });
			log.liveTasks.add(taskId);
			// A SCHEDULED tick, not a manual one: the guard only binds the schedule.
			await runner.runNow(id, { manual: false });
			expect(log.spawned).toHaveLength(1);
			expect(log.stopped).toHaveLength(0); // a live pane is never killed
			expect(repo.getLoop(db, id)?.lastSummary).toContain("skipped");
			runner.stop();
		});

		it("does not wedge on a stale 'running' status when the PTY is gone", async () => {
			// The exit-while-app-closed case: agentStatus strands at "running" (no
			// reconciler backstop anymore), but the daemon reports no live PTY —
			// the loop must proceed, not skip forever.
			const projectId = seedProject();
			const log = makeLog();
			const runner = makeRunner(log); // nothing is live
			runner.start();
			const id = seedLoop(runner, projectId);

			await runner.runNow(id);
			repo.updateTask(db, repo.getLoop(db, id)?.config?.taskId as string, {
				agentStatus: "running",
			});
			await runner.runNow(id);
			expect(log.spawned).toHaveLength(2);
			runner.stop();
		});

		it("hands every tick the state file, and keeps it out of the task's description", async () => {
			// The loop's own notes: each tick is a fresh process, so the only thing that
			// survives is the worktree. The instructions must NOT reach `description`,
			// which is the task's record of intent and feeds tagging and search.
			const projectId = seedProject();
			const log = makeLog();
			const runner = makeRunner(log);
			runner.start();
			const id = seedLoop(runner, projectId);

			await runner.runNow(id);
			const sent = log.spawned[0]?.prompt as string;
			// ABSOLUTE path: "relative to the repository root" is ambiguous inside a
			// worktree, and one loop resolved it to the main checkout, where every
			// loop on that repo then shared a single file.
			const worktree = repo.getTask(db, repo.getLoop(db, id)?.config?.taskId as string)
				?.worktreePath as string;
			expect(sent).toContain(`${worktree}/.ateam/loop-state.md`);
			expect(sent).toContain("never one outside this worktree");
			expect(sent).toContain("update deps"); // the user's prompt still leads the task
			// Writes are not tied to completion; the text says so in as many words.
			expect(sent).toContain("not only when you finish");

			const taskId = repo.getLoop(db, id)?.config?.taskId as string;
			expect(repo.getTask(db, taskId)?.description).toBe("update deps");
			runner.stop();
		});

		it("protects a FRESH prompt: a recent awaiting_input still blocks a tick", async () => {
			// A question you are seconds from answering deserves the same protection as
			// a running turn — the tick would otherwise kill the pane under you.
			const projectId = seedProject();
			const log = makeLog();
			const runner = makeRunner(log);
			runner.start();
			const id = seedLoop(runner, projectId);

			await runner.runNow(id);
			const taskId = repo.getLoop(db, id)?.config?.taskId as string;
			repo.updateTask(db, taskId, { agentStatus: "awaiting_input" });
			log.liveTasks.add(taskId);

			await runner.runNow(id, { manual: false });
			expect(log.spawned).toHaveLength(1);
			runner.stop();
		});

		it("breaks the latch: a long-silent session never blocks a tick", async () => {
			// The wedge that stopped every long-lived loop. Both statuses latched the
			// same way — the skip spawned nothing, so no hook fired, so the status that
			// caused the skip could never change. Recency is what bounds it.
			const stale = Date.now() - 3 * 60 * 60 * 1000;
			for (const status of ["running", "awaiting_input"] as const) {
				db = createTestDb();
				const projectId = seedProject();
				const log = makeLog();
				const runner = makeRunner(log);
				runner.start();
				const id = seedLoop(runner, projectId);

				await runner.runNow(id);
				const taskId = repo.getLoop(db, id)?.config?.taskId as string;
				repo.updateTask(db, taskId, { agentStatus: status });
				log.liveTasks.add(taskId);
				for (const sess of repo.listSessionsByTask(db, taskId)) {
					repo.updateSession(db, sess.id, { lastEventAt: stale });
				}

				await runner.runNow(id, { manual: false });
				expect(log.spawned).toHaveLength(2);
				runner.stop();
			}
		});

		it("Run now overrides the guard even while the agent is working", async () => {
			// The scheduled tick protects real work; a human pressing the button is
			// asking for a run and can see what it replaces.
			const projectId = seedProject();
			const log = makeLog();
			const runner = makeRunner(log);
			runner.start();
			const id = seedLoop(runner, projectId);

			await runner.runNow(id);
			const taskId = repo.getLoop(db, id)?.config?.taskId as string;
			repo.updateTask(db, taskId, { agentStatus: "running" });
			log.liveTasks.add(taskId);

			await runner.runNow(id, { manual: false });
			expect(log.spawned).toHaveLength(1); // schedule defers to live work

			await runner.runNow(id); // manual by default
			expect(log.spawned).toHaveLength(2);
			expect(log.stopped).toContain(taskId); // the old pane is replaced
			runner.stop();
		});

		it("does not count a skipped tick as a run", async () => {
			// `lastRunAt` is what a restart computes the next due time from, so a
			// skip that stamped it would silently push the schedule forward.
			const projectId = seedProject();
			const log = makeLog();
			const runner = makeRunner(log);
			runner.start();
			const id = seedLoop(runner, projectId);

			await runner.runNow(id);
			const afterRun = repo.getLoop(db, id);
			expect(afterRun?.runs).toBe(1);

			const taskId = afterRun?.config?.taskId as string;
			repo.updateTask(db, taskId, { agentStatus: "running" });
			log.liveTasks.add(taskId);
			await runner.runNow(id, { manual: false });

			const afterSkip = repo.getLoop(db, id);
			expect(log.spawned).toHaveLength(1);
			expect(afterSkip?.runs).toBe(1); // the skip did not count
			expect(afterSkip?.lastRunAt).toBe(afterRun?.lastRunAt as number);
			expect(afterSkip?.lastSummary).toContain("skipped"); // but it is reported
			runner.stop();
		});

		it("records an error when the loop has no prompt", async () => {
			const projectId = seedProject();
			const runner = makeRunner();
			runner.start();
			const id = runner
				.createUserLoop({
					templateId: "agent-session",
					name: "Broken",
					projectId,
					config: {},
				})
				.find((l) => l.kind === "user")?.id as string;

			await runner.runNow(id);
			expect(repo.getLoop(db, id)?.lastStatus).toBe("error");
			expect(repo.getLoop(db, id)?.lastError).toContain("prompt");
			runner.stop();
		});
	});

	// Timers die with the process (locally the runner is started by the desktop
	// app), but the schedule lives in the row. A restart that always waited a
	// fresh interval pushed the loop further out every launch, so a loop with an
	// interval longer than the app's uptime never ran at all.
	describe("schedule across restarts", () => {
		const HOUR = 3_600_000;

		/** Create a fixed-cadence user loop, then drop the runner that made it. */
		function seedThenStop(projectId: string): string {
			const runner = makeRunner();
			runner.start();
			const id = runner
				.createUserLoop({
					templateId: "agent-session",
					name: "Nightly deps",
					projectId,
					config: { prompt: "update deps", agentId: "claude" },
					cadenceMode: "fixed",
					intervalMs: HOUR,
				})
				.find((l) => l.kind === "user")?.id as string;
			runner.stop();
			return id;
		}

		/** Milliseconds from now until the loop's scheduled next run. */
		function dueInMs(runner: LoopRunner, id: string): number {
			const next = runner.describe().find((l) => l.id === id)?.nextRunAt;
			if (next == null) throw new Error("loop is not scheduled");
			return next - Date.now();
		}

		it("resumes the remaining interval instead of restarting the clock", () => {
			const projectId = seedProject();
			const id = seedThenStop(projectId);
			// It last ran 30 minutes ago, so 30 minutes of the hour are left.
			repo.updateLoop(db, id, { lastRunAt: Date.now() - HOUR / 2 });

			const restarted = makeRunner();
			restarted.start();
			expect(dueInMs(restarted, id)).toBeLessThan(HOUR / 2 + 2_000);
			expect(dueInMs(restarted, id)).toBeGreaterThan(HOUR / 2 - 2_000);
			restarted.stop();
		});

		it("catches an overdue loop up once, shortly after start", () => {
			const projectId = seedProject();
			const id = seedThenStop(projectId);
			// The app was closed for five hours: five ticks were missed.
			repo.updateLoop(db, id, { lastRunAt: Date.now() - 5 * HOUR });

			const restarted = makeRunner();
			restarted.start();
			const due = dueInMs(restarted, id);
			// One catch-up run, after a settle delay — never a five-run backlog,
			// and never immediately, into a half-booted app.
			expect(due).toBeGreaterThan(0);
			expect(due).toBeLessThan(90_000);
			expect(repo.getLoop(db, id)?.runs).toBe(0);
			restarted.stop();
		});

		it("keeps the scheduled time of a loop that has never run", () => {
			const projectId = seedProject();
			const id = seedThenStop(projectId);
			// Created 45 minutes ago and never run, so it is due in 15 — with no
			// lastRunAt to work from, the persisted nextRunAt is what carries it.
			repo.updateLoop(db, id, { lastRunAt: null, nextRunAt: Date.now() + HOUR / 4 });

			const restarted = makeRunner();
			restarted.start();
			expect(dueInMs(restarted, id)).toBeLessThan(HOUR / 4 + 2_000);
			expect(dueInMs(restarted, id)).toBeGreaterThan(HOUR / 4 - 2_000);
			restarted.stop();
		});

		it("starts a brand-new loop a full interval out", () => {
			const projectId = seedProject();
			const id = seedThenStop(projectId);

			const restarted = makeRunner();
			restarted.start();
			expect(dueInMs(restarted, id)).toBeGreaterThan(HOUR - 2_000);
			restarted.stop();
		});
	});
});
