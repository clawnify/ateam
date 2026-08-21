import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { AteamDb } from "@ateam/db";
import { bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import { LoopRunner, type LoopRunnerDeps } from "../src/loops/runner";
import type { LoopDefinition, StartAgentRunInput } from "../src/loops/types";

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

/** Fake session starter: records calls and creates a real task row, so the
 *  agent-session template's previous-run liveness check sees real state. */
function makeStartAgentRun(started: StartAgentRunInput[]): LoopRunnerDeps["startAgentRun"] {
	return async (input) => {
		started.push(input);
		const task = repo.createTask(db, {
			projectId: input.projectId,
			name: input.name,
			slug: `run-${started.length}`,
			branch: `loop/run-${started.length}`,
			baseBranch: "main",
			worktreePath: `/tmp/loop-run-${started.length}`,
		});
		return { taskId: task.id };
	};
}

function makeRunner(started: StartAgentRunInput[] = [], liveTasks = new Set<string>()): LoopRunner {
	return new LoopRunner({
		db,
		startAgentRun: makeStartAgentRun(started),
		isTaskAgentLive: (taskId) => liveTasks.has(taskId),
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
		it("each run starts a fresh task named after the loop and run number", async () => {
			const projectId = seedProject();
			const started: StartAgentRunInput[] = [];
			const runner = makeRunner(started);
			runner.start();
			const id = runner
				.createUserLoop({
					templateId: "agent-session",
					name: "Nightly deps",
					projectId,
					config: { prompt: "update deps", agentId: "codex" },
				})
				.find((l) => l.kind === "user")?.id as string;

			await runner.runNow(id);
			expect(started).toHaveLength(1);
			expect(started[0]).toMatchObject({
				projectId,
				agentId: "codex",
				prompt: "update deps",
				name: "Nightly deps #1",
			});

			// Previous run's task is done → the next tick starts run #2.
			repo.updateTask(db, repo.getLoop(db, id)?.config?.lastTaskId as string, {
				agentStatus: "stopped",
			});
			await runner.runNow(id);
			expect(started).toHaveLength(2);
			expect(started[1]?.name).toBe("Nightly deps #2");
			runner.stop();
		});

		it("skips a tick while the previous run's agent is still working", async () => {
			const projectId = seedProject();
			const started: StartAgentRunInput[] = [];
			const liveTasks = new Set<string>();
			const runner = makeRunner(started, liveTasks);
			runner.start();
			const id = runner
				.createUserLoop({
					templateId: "agent-session",
					name: "Nightly deps",
					projectId,
					config: { prompt: "update deps" },
				})
				.find((l) => l.kind === "user")?.id as string;

			await runner.runNow(id);
			expect(started).toHaveLength(1);
			// The spawned agent is still running (live PTY) → the next tick must
			// not stack.
			const lastTaskId = repo.getLoop(db, id)?.config?.lastTaskId as string;
			repo.updateTask(db, lastTaskId, { agentStatus: "running" });
			liveTasks.add(lastTaskId);
			await runner.runNow(id);
			expect(started).toHaveLength(1);
			expect(repo.getLoop(db, id)?.lastSummary).toContain("skipped");
			runner.stop();
		});

		it("does not wedge on a stale 'running' status when the PTY is gone", async () => {
			// The exit-while-app-closed case: agentStatus strands at "running" (no
			// reconciler backstop anymore), but the daemon reports no live PTY —
			// the loop must proceed, not skip forever.
			const projectId = seedProject();
			const started: StartAgentRunInput[] = [];
			const runner = makeRunner(started); // nothing is live
			runner.start();
			const id = runner
				.createUserLoop({
					templateId: "agent-session",
					name: "Nightly deps",
					projectId,
					config: { prompt: "update deps" },
				})
				.find((l) => l.kind === "user")?.id as string;

			await runner.runNow(id);
			repo.updateTask(db, repo.getLoop(db, id)?.config?.lastTaskId as string, {
				agentStatus: "running",
			});
			await runner.runNow(id);
			expect(started).toHaveLength(2);
			expect(started[1]?.name).toBe("Nightly deps #2");
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
});
