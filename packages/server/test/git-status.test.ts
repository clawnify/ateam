import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempRepoPair, type TempRepo } from "../../git-core/test/helpers/temp-repo";
import { computeGitStatus } from "../src/worktree-sweep";

// Real clones and pushes outlive bun's 5s default.
setDefaultTimeout(20_000);

let repo: TempRepo;
beforeEach(async () => {
	repo = await makeTempRepoPair();
});
afterEach(async () => {
	await repo.cleanup();
});

// The card and the Mission Control tile show a task's size as +N -M from this
// snapshot, and the task panel's button shows it from a live diff. Both must
// count the same lines: committed work on the branch, edits not yet committed,
// and files git does not track yet.
describe("computeGitStatus", () => {
	it("counts the lines added and removed across committed, uncommitted and new files", async () => {
		await repo.git.checkoutLocalBranch("task");
		await writeFile(join(repo.work, "README.md"), "# temp repo, edited\nsecond line\n");
		await repo.git.add("README.md");
		await repo.git.commit("edit the readme");
		await writeFile(join(repo.work, "notes.txt"), "one\ntwo\nthree\n");

		const status = await computeGitStatus(repo.work, "main");

		// README: 2 lines in for 1 out. notes.txt: 3 new lines, untracked.
		expect(status.dirty).toBe(2);
		expect(status.additions).toBe(5);
		expect(status.deletions).toBe(1);
	});

	it("reads zero for a task with no work yet", async () => {
		await repo.git.checkoutLocalBranch("task");

		const status = await computeGitStatus(repo.work, "main");

		expect(status).toMatchObject({ dirty: 0, additions: 0, deletions: 0 });
	});
});
