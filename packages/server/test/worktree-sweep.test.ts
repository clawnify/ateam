import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AteamDb, repo as rows } from "@ateam/db";
import { createTask, push } from "@ateam/git-core";
import { createTestDb } from "../../db/test/helpers/test-db";
import {
	advanceOrigin,
	commitFile,
	makeTempRepoPair,
	squashMergeOnOrigin,
	type TempRepo,
} from "../../git-core/test/helpers/temp-repo";
import { createWorktreeSweep } from "../src/worktree-sweep";

// Real clones and pushes outlive bun's 5s default.
setDefaultTimeout(30_000);

let repo: TempRepo;
let savedPath: string | undefined;

// A fake `gh` answering every `pr view` with the PR in $FAKE_GH_PR.
beforeEach(async () => {
	repo = await makeTempRepoPair();
	const bin = join(repo.dir, "fake-gh-bin");
	await mkdir(bin);
	await writeFile(join(bin, "gh"), '#!/bin/sh\nprintf "%s" "$FAKE_GH_PR"\n');
	await chmod(join(bin, "gh"), 0o755);
	savedPath = process.env.PATH;
	process.env.PATH = `${bin}:${process.env.PATH}`;
});
afterEach(async () => {
	process.env.PATH = savedPath;
	delete process.env.FAKE_GH_PR;
	await repo.cleanup();
});

/** One probe, as the background pass or an open panel would run it. A fresh
 *  sweep each time, so neither throttle skips it. */
async function probe(db: AteamDb, taskId: string) {
	const sweep = createWorktreeSweep({ db, onTaskUpdated: () => {}, isLive: () => false });
	await sweep.refresh(taskId);
	return rows.getTask(db, taskId);
}

// The bug: a PR that merged while its branch went on to hold other commits read
// "open" for good, because only a merge AT the branch tip was believed.
describe("a task whose PR merged before its branch moved", () => {
	it("records the PR merged, keeps the card out of Done until the later work lands", async () => {
		const wt = await createTask({ repoPath: repo.work, name: "carried on" });
		const head = await commitFile(wt.worktreePath, "a.txt", "a\n", "the PR");
		await push({ worktreePath: wt.worktreePath, branch: wt.branch });
		await squashMergeOnOrigin(repo, wt.branch);
		await commitFile(wt.worktreePath, "b.txt", "b\n", "after the merge");
		process.env.FAKE_GH_PR = JSON.stringify({
			number: 7,
			state: "MERGED",
			url: "https://github.com/acme/demo/pull/7",
			headRefOid: head,
		});

		const db = createTestDb();
		const project = rows.upsertProject(db, { repoPath: repo.work, name: "demo" });
		if (!project) throw new Error("failed to seed the project");
		const { id } = rows.createTask(db, {
			projectId: project.id,
			name: "carried on",
			slug: "carried-on",
			branch: wt.branch,
			baseBranch: "main",
			worktreePath: wt.worktreePath,
		});
		rows.updateTask(db, id, {
			column: "review",
			agentStatus: "idle",
			prNumber: 7,
			prState: "open",
		});

		const first = await probe(db, id);
		expect(first?.prState).toBe("merged");
		expect(first?.column).toBe("review");
		expect(first?.gitStatus?.workAfterMerge).toBe(true);

		// The later commit lands on main through a PR of its own.
		await advanceOrigin(repo, { file: "b.txt", content: "b\n", message: "after the merge (#8)" });
		const second = await probe(db, id);
		expect(second?.column).toBe("merged");
		expect(second?.prState).toBe("merged");
		expect(second?.gitStatus?.workAfterMerge).toBeUndefined();
	});
});
