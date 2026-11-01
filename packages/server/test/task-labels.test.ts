import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { AteamDb, Task } from "@ateam/db";
import { bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import { labelTask } from "../src/task-labels";

function createTestDb(): AteamDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	bootstrap(sqlite);
	return drizzle(sqlite, { schema }) as unknown as AteamDb;
}

let db: AteamDb;
let projectId: string;
let notified: string[];

function seedTask(name: string, patch: Partial<Task> = {}): string {
	return repo.createTask(db, {
		projectId,
		name,
		slug: "on-sidebar-collapsed-i-am-not",
		branch: "on-sidebar-collapsed-i-am-not",
		baseBranch: "main",
		worktreePath: "/tmp/wt",
		description: "on sidebar collapsed I am not seeing the unread dot",
		...patch,
	}).id;
}

const task = (id: string) => repo.getTask(db, id) as Task;
const replying = (reply: string | null) => () => Promise.resolve(reply);
const deps = (ask: (prompt: string) => Promise<string | null>) => ({
	db,
	notifyTaskUpdated: (id: string) => notified.push(id),
	ask,
});

const REPLY = '{"title":"Unread dot in collapsed sidebar","tags":["ui","bug"]}';

beforeEach(() => {
	db = createTestDb();
	notified = [];
	const project = repo.upsertProject(db, {
		repoPath: "/tmp/repo",
		name: "Repo",
		defaultBranch: "main",
	});
	if (!project) throw new Error("failed to seed project");
	projectId = project.id;
});

describe("labelTask", () => {
	it("replaces a name nobody typed, once, and leaves the branch alone", async () => {
		const id = seedTask("on sidebar collapsed I am not", { nameAuto: true });
		await labelTask(deps(replying(REPLY)), id);
		expect(task(id).name).toBe("Unread dot in collapsed sidebar");
		expect(task(id).branch).toBe("on-sidebar-collapsed-i-am-not");
		expect(task(id).tags).toEqual(["ui", "bug"]);
		expect(task(id).nameAuto).toBe(false);
		expect(notified).toEqual([id]);
	});

	it("never renames a name someone chose, but still tags", async () => {
		const id = seedTask("Stripe webhooks");
		await labelTask(deps(replying(REPLY)), id);
		expect(task(id).name).toBe("Stripe webhooks");
		expect(task(id).tags).toEqual(["ui", "bug"]);
	});

	// Other agents learn names: one that changed later would lose them.
	it("gives the title one attempt: a failure keeps the first words for good", async () => {
		const id = seedTask("on sidebar collapsed I am not", { nameAuto: true });
		await labelTask(deps(replying(null)), id);
		expect(task(id).name).toBe("on sidebar collapsed I am not");
		expect(task(id).nameAuto).toBe(false);
		// A later launch retries the tags, never the name.
		await labelTask(deps(replying(REPLY)), id);
		expect(task(id).name).toBe("on sidebar collapsed I am not");
		expect(task(id).tags).toEqual(["ui", "bug"]);
	});

	it("never changes a title once written", async () => {
		const id = seedTask("on sidebar collapsed I am not", { nameAuto: true });
		await labelTask(deps(replying(REPLY)), id);
		repo.updateTask(db, id, { tags: null });
		await labelTask(deps(replying('{"title":"Something else","tags":["perf"]}')), id);
		expect(task(id).name).toBe("Unread dot in collapsed sidebar");
		expect(task(id).tags).toEqual(["perf"]);
	});

	it("does not call the model when there is nothing to label", async () => {
		let calls = 0;
		const ask = () => {
			calls += 1;
			return Promise.resolve(REPLY);
		};
		const tagged = seedTask("Tagged already", { tags: ["db"] });
		await labelTask(deps(ask), tagged);
		const noPrompt = seedTask("task 2026-11-01", { nameAuto: true, description: null });
		await labelTask(deps(ask), noPrompt);
		expect(calls).toBe(0);
		expect(task(noPrompt).nameAuto).toBe(false);
	});

	it("does nothing for a task deleted while the model was answering", async () => {
		const id = seedTask("on sidebar collapsed I am not", { nameAuto: true });
		await labelTask(
			deps(async () => {
				repo.deleteTask(db, id);
				return REPLY;
			}),
			id,
		);
		expect(repo.getTask(db, id)).toBeUndefined();
		expect(notified).toEqual([]);
	});
});
