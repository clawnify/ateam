import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import simpleGit from "simple-git";
import {
	commit,
	createTask,
	detectDefaultBranch,
	diff,
	parseWorktreeList,
	registerProject,
	removeTask,
	safeResolveWorktreePath,
	slugify,
	updateFromBase,
	updateLocalMain,
} from "../src/index";
import { GitCoreError } from "../src/errors";
import {
	advanceOrigin,
	commitFile,
	makeTempRepoPair,
	type TempRepo,
} from "./helpers/temp-repo";

let repo: TempRepo;

beforeEach(async () => {
	repo = await makeTempRepoPair();
});
afterEach(async () => {
	await repo.cleanup();
});

async function porcelainStatus(dir: string): Promise<string> {
	return (await simpleGit(dir).raw(["status", "--porcelain"])).trim();
}
async function headSha(dir: string): Promise<string> {
	return (await simpleGit(dir).revparse(["HEAD"])).trim();
}
async function branchSha(dir: string, branch: string): Promise<string> {
	return (await simpleGit(dir).revparse([branch])).trim();
}

describe("project", () => {
	it("registers a repo and detects the default branch", async () => {
		const info = await registerProject(repo.work);
		expect(info.defaultBranch).toBe("main");
		expect(info.mainWorktreePath).toBe(info.repoPath);
	});

	it("detectDefaultBranch returns main", async () => {
		expect(await detectDefaultBranch(repo.work)).toBe("main");
	});

	it("adds /.ateam/ to .git/info/exclude", async () => {
		await registerProject(repo.work);
		const exclude = await Bun.file(
			join(repo.work, ".git", "info", "exclude"),
		).text();
		expect(exclude).toContain("/.ateam/");
	});

	it("throws NOT_A_REPO for a non-repo path", async () => {
		await expect(registerProject(repo.dir)).rejects.toMatchObject({
			code: "NOT_A_REPO",
		});
	});
});

describe("createTask isolation", () => {
	it("creates a co-located worktree without disturbing the main worktree", async () => {
		const headBefore = await simpleGit(repo.work).raw([
			"symbolic-ref",
			"HEAD",
		]);
		const statusBefore = await porcelainStatus(repo.work);

		const task = await createTask({ repoPath: repo.work, name: "Add auth" });

		expect(task.slug).toBe("add-auth");
		expect(task.branch).toBe("add-auth");
		expect(task.baseBranch).toBe("main");
		expect(task.worktreePath).toBe(
			join(repo.work, ".ateam", "worktrees", "add-auth"),
		);
		expect(existsSync(task.worktreePath)).toBe(true);

		// Main worktree HEAD + working tree byte-for-byte unchanged.
		expect(await simpleGit(repo.work).raw(["symbolic-ref", "HEAD"])).toBe(
			headBefore,
		);
		expect(await porcelainStatus(repo.work)).toBe(statusBefore);
	});

	it("keeps two tasks mutually isolated", async () => {
		const a = await createTask({ repoPath: repo.work, name: "task a" });
		const b = await createTask({ repoPath: repo.work, name: "task b" });

		await commitFile(a.worktreePath, "a.txt", "a\n", "work in A");

		// B's working tree and branch are untouched by work in A.
		expect(await porcelainStatus(b.worktreePath)).toBe("");
		expect(existsSync(join(b.worktreePath, "a.txt"))).toBe(false);
	});
});

describe("updateFromBase", () => {
	it("pulls origin/main into task A but not sibling task B", async () => {
		const a = await createTask({ repoPath: repo.work, name: "task a" });
		const b = await createTask({ repoPath: repo.work, name: "task b" });

		await advanceOrigin(repo, { file: "feature.txt", content: "feat\n" });

		const res = await updateFromBase({
			worktreePath: a.worktreePath,
			baseBranch: "main",
			strategy: "merge",
		});
		expect(res.status).toBe("clean");
		expect(existsSync(join(a.worktreePath, "feature.txt"))).toBe(true);
		expect(existsSync(join(b.worktreePath, "feature.txt"))).toBe(false);
	});
});

describe("updateLocalMain — Stage B safety (no GitHub needed)", () => {
	it("mechanism 2: fast-forwards the main worktree when main is checked out there", async () => {
		const newSha = await advanceOrigin(repo);
		// `work` has main checked out, so the direct-ref fetch is refused and we
		// route to ff inside the owning worktree.
		const res = await updateLocalMain(repo.work, "main");
		expect(res.localMainUpdated).toBe(true);
		expect(res.localMainStrategy).toBe("ff-worktree");
		expect(await branchSha(repo.work, "main")).toBe(newSha);
		// Working tree stays clean — a fast-forward, not a clobber.
		expect(await porcelainStatus(repo.work)).toBe("");
	});

	it("mechanism 1: direct ref fast-forward when main is checked out nowhere", async () => {
		// Free up main by detaching the primary checkout (simulating a repo whose
		// primary checkout sits on a feature branch / detached HEAD).
		await simpleGit(repo.work).raw(["checkout", "--detach"]);

		const newSha = await advanceOrigin(repo);
		const res = await updateLocalMain(repo.work, "main");

		expect(res.localMainUpdated).toBe(true);
		expect(res.localMainStrategy).toBe("direct-ref");
		expect(await branchSha(repo.work, "main")).toBe(newSha);
	});

	it("aborts cleanly without clobbering when local main has diverged", async () => {
		// Local divergent commit on work's main.
		const localSha = await commitFile(
			repo.work,
			"local.txt",
			"local\n",
			"divergent local commit",
		);
		// Remote advances on a different line of history.
		await advanceOrigin(repo, { file: "remote.txt", content: "remote\n" });

		const res = await updateLocalMain(repo.work, "main");

		expect(res.localMainUpdated).toBe(false);
		expect(res.localMainStrategy).toBe("skipped");
		expect(res.reason).toBe("diverged");
		// Local main is exactly where we left it — nothing clobbered.
		expect(await branchSha(repo.work, "main")).toBe(localSha);
		expect(existsSync(join(repo.work, "local.txt"))).toBe(true);
	});
});

describe("removeTask", () => {
	it("removes only the target worktree, leaving siblings intact", async () => {
		const a = await createTask({ repoPath: repo.work, name: "task a" });
		const b = await createTask({ repoPath: repo.work, name: "task b" });

		const res = await removeTask({
			repoPath: repo.work,
			worktreePath: a.worktreePath,
			branch: a.branch,
			deleteBranch: true,
		});

		expect(res.removed).toBe(true);
		expect(existsSync(a.worktreePath)).toBe(false);
		expect(existsSync(b.worktreePath)).toBe(true);

		const list = parseWorktreeList(
			await simpleGit(repo.work).raw(["worktree", "list", "--porcelain"]),
		);
		expect(list.some((w) => w.branch === a.branch)).toBe(false);
		expect(list.some((w) => w.branch === b.branch)).toBe(true);
	});
});

describe("commit & diff", () => {
	it("commits staged changes and reports them in diff", async () => {
		const task = await createTask({ repoPath: repo.work, name: "feature x" });
		await Bun.write(join(task.worktreePath, "x.txt"), "hello\nworld\n");

		const before = await diff({
			worktreePath: task.worktreePath,
			baseBranch: "main",
		});
		expect(before.files.some((f) => f.path === "x.txt")).toBe(true);

		const { sha } = await commit({
			worktreePath: task.worktreePath,
			message: "add x",
		});
		expect(sha).toMatch(/^[0-9a-f]{40}$/);
		expect(await headSha(task.worktreePath)).toBe(sha);

		const after = await diff({
			worktreePath: task.worktreePath,
			baseBranch: "main",
		});
		const x = after.files.find((f) => f.path === "x.txt");
		expect(x?.additions).toBe(2);
	});
});

describe("path safety", () => {
	it("safeResolveWorktreePath rejects traversal", () => {
		expect(() => safeResolveWorktreePath("/repo", "../../evil")).toThrow(
			GitCoreError,
		);
	});

	it("slugify neutralizes traversal characters", () => {
		expect(slugify("../../evil")).toBe("evil");
		expect(slugify("Add Auth!!")).toBe("add-auth");
	});
});
