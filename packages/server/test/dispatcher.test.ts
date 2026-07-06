import { describe, expect, it } from "bun:test";
import { type AteamDb, repo } from "@ateam/db";
import { CH } from "@ateam/protocol";
// Reuse the db package's in-memory bun:sqlite test db (better-sqlite3 can't load
// under Bun). Cross-package test helper — the DRY source of a test AteamDb.
import { createTestDb } from "../../db/test/helpers/test-db";
import type { Engine } from "../src/engine";
import { createDispatcher } from "../src/dispatcher";

// A minimal fake Engine: a real in-memory db for the DB-backed handlers, stubs
// for the pieces those handlers don't touch, and a spy on taskUpdated so we can
// assert the extraction still emits it.
function makeEngine(db: AteamDb) {
	const taskUpdated: string[] = [];
	const engine = {
		services: {
			db,
			pty: { has: () => false, kill() {}, write() {}, resize() {} },
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
	return { engine, taskUpdated };
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
		expect(d.methods).not.toContain(CH.utilStageImage);
		expect(d.methods).not.toContain(CH.utilStageImagePath);
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
});
