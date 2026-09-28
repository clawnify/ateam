import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AteamDb, Task } from "@ateam/db";
import { bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import {
	advanceOrigin,
	makeTempRepoPair,
	type TempRepo,
} from "../../git-core/test/helpers/temp-repo";
import { type MergeJobInput, MergeQueue } from "../src/merge-queue";

// Real git, no GitHub: `gh pr view` fails fast on a local-path remote, so the
// job's PR gate reads NONE and proceeds to the base update, which is the step
// under test. A job that gets past it fails at the PR merge, which is fine here.

function createTestDb(): AteamDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	bootstrap(sqlite);
	return drizzle(sqlite, { schema }) as unknown as AteamDb;
}

let db: AteamDb;
let tmp: TempRepo;
let task: Task;

const job = (): MergeJobInput => ({
	task,
	repoPath: tmp.work,
	strategy: "squash",
	updateStrategy: "merge",
	deleteRemoteBranch: false,
});

beforeEach(async () => {
	db = createTestDb();
	tmp = await makeTempRepoPair();
	// The task branch and main both rewrite README.md: a genuine conflict.
	await tmp.git.checkoutLocalBranch("task");
	await writeFile(join(tmp.work, "README.md"), "# task side\n");
	await tmp.git.add("README.md");
	await tmp.git.commit("task edit");
	await advanceOrigin(tmp, { file: "README.md", content: "# main side\n" });

	const project = repo.upsertProject(db, { repoPath: tmp.work, name: "Repo", defaultBranch: "main" });
	if (!project) throw new Error("failed to seed project");
	task = repo.createTask(db, {
		projectId: project.id,
		name: "task",
		slug: "task",
		branch: "task",
		baseBranch: "main",
		worktreePath: tmp.work,
	});
});

afterEach(() => tmp.cleanup());

describe("MergeQueue — a parked conflict does not lock the task", () => {
	it("returns the conflict, and a retry runs instead of answering busy", async () => {
		const q = new MergeQueue({ db, onTaskUpdated: () => {} });

		const first = await q.enqueue(job());
		expect(first).toEqual({ ok: false, reason: "conflict", conflicts: ["README.md"] });
		expect(repo.getTask(db, task.id)?.mergeStatus).toBe("conflict");
		expect(repo.getTask(db, task.id)?.column).toBe("needs_attention");

		// Unresolved: the retry runs again and reports the same conflict.
		const again = await q.enqueue(job());
		expect(again).toEqual({ ok: false, reason: "conflict", conflicts: ["README.md"] });

		// Resolved and committed: the retry absorbs the base and moves on to the
		// PR merge (which fails here, with no GitHub), never answering busy.
		await writeFile(join(tmp.work, "README.md"), "# both sides\n");
		await tmp.git.add("README.md");
		await tmp.git.raw(["commit", "--no-edit"]);
		const resolved = await q.enqueue(job());
		expect(resolved.ok).toBe(false);
		if (!resolved.ok) expect(resolved.reason).toBe("error");
		expect(repo.getTask(db, task.id)?.mergeStatus).toBeNull();
	});

	it("answers busy only while a job for the task is actually in flight", async () => {
		const q = new MergeQueue({ db, onTaskUpdated: () => {} });
		const first = q.enqueue(job());
		expect(await q.enqueue(job())).toEqual({ ok: false, reason: "busy" });
		await first;
	});

	it("drops queue positions a previous process left behind, keeps a conflict", () => {
		const other = repo.createTask(db, {
			projectId: task.projectId,
			name: "other",
			slug: "other",
			branch: "other",
			baseBranch: "main",
			worktreePath: "/tmp/other",
		});
		repo.updateTask(db, task.id, { mergeStatus: "merging" });
		repo.updateTask(db, other.id, { mergeStatus: "conflict" });

		new MergeQueue({ db, onTaskUpdated: () => {} });

		expect(repo.getTask(db, task.id)?.mergeStatus).toBeNull();
		expect(repo.getTask(db, other.id)?.mergeStatus).toBe("conflict");
	});
});
