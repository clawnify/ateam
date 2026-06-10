import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { AteamDb } from "@ateam/db";
import { bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../../packages/db/src/schema";
import { LoopRunner } from "../src/main/loops/runner";
import type { LoopDefinition } from "../src/main/loops/types";

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
const noop = () => {};

beforeEach(() => {
	db = createTestDb();
});

describe("LoopRunner", () => {
	it("instantiates a global loop and lists it as enabled", () => {
		const runner = new LoopRunner({ db, onTaskUpdated: noop });
		runner.register(makeDef("a", async () => ({ summary: "ok" })));
		runner.start();

		const loops = runner.describe();
		expect(loops).toHaveLength(1);
		expect(loops[0]).toMatchObject({ id: "a", enabled: true, runs: 0 });
		runner.stop();
	});

	it("runNow executes the run and records telemetry", async () => {
		let calls = 0;
		const runner = new LoopRunner({ db, onTaskUpdated: noop });
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
		const runner = new LoopRunner({ db, onTaskUpdated: noop });
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
		const runner = new LoopRunner({ db, onTaskUpdated: noop });
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
		const runner = new LoopRunner({ db, onTaskUpdated: noop });
		runner.register(makeDef("a", async () => ({ summary: "fin", done: true })));
		runner.start();

		await runner.runNow("a");
		expect(runner.describe()).toHaveLength(0);
		expect(repo.getLoop(db, "a")).toBeUndefined();
		runner.stop();
	});

	it("persists enabled state across runner restarts", () => {
		const first = new LoopRunner({ db, onTaskUpdated: noop });
		first.register(makeDef("a", async () => ({})));
		first.start();
		first.setEnabled("a", false);
		first.stop();

		const second = new LoopRunner({ db, onTaskUpdated: noop });
		second.register(makeDef("a", async () => ({})));
		second.start();
		// The disabled flag from the prior run survives (row was persisted).
		expect(second.describe()[0].enabled).toBe(false);
		second.stop();
	});

	it("creates a user loop from a template and persists it across restarts", () => {
		const runner = new LoopRunner({ db, onTaskUpdated: noop });
		runner.start();

		const loops = runner.createUserLoop({
			templateId: "pr-ci-watcher",
			name: "Watch CI",
		});
		const created = loops.find((l) => l.kind === "user");
		expect(created).toBeDefined();
		expect(created?.title).toBe("Watch CI");
		expect(created?.templateId).toBe("pr-ci-watcher");
		expect(created?.enabled).toBe(true);
		runner.stop();

		// A fresh runner rebuilds the user loop from its persisted row.
		const restarted = new LoopRunner({ db, onTaskUpdated: noop });
		restarted.start();
		const again = restarted.describe().find((l) => l.kind === "user");
		expect(again?.title).toBe("Watch CI");
		expect(again?.templateId).toBe("pr-ci-watcher");
		restarted.stop();
	});

	it("rejects an unknown template", () => {
		const runner = new LoopRunner({ db, onTaskUpdated: noop });
		runner.start();
		expect(() => runner.createUserLoop({ templateId: "nope", name: "x" })).toThrow(
			/Unknown loop template/,
		);
		runner.stop();
	});

	it("deletes a user loop and its row", () => {
		const runner = new LoopRunner({ db, onTaskUpdated: noop });
		runner.start();
		const loops = runner.createUserLoop({
			templateId: "auto-merge-when-green",
			name: "Auto-merge",
		});
		const id = loops.find((l) => l.kind === "user")?.id as string;
		expect(id).toBeTruthy();

		const after = runner.deleteUserLoop(id);
		expect(after.find((l) => l.id === id)).toBeUndefined();
		expect(repo.getLoop(db, id)).toBeUndefined();
		runner.stop();
	});
});
