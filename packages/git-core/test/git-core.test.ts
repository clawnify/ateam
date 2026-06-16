import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import simpleGit from "simple-git";
import {
	commit,
	createTask,
	detectDefaultBranch,
	detectMerged,
	diff,
	initRepository,
	push,
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

	it("copies the Supabase link state into the new worktree", async () => {
		// Simulate `supabase link`: the gitignored link cache in the main repo.
		await mkdir(join(repo.work, "supabase", ".temp"), { recursive: true });
		await writeFile(
			join(repo.work, "supabase", ".temp", "project-ref"),
			"abcdefghijklmnopqrst",
		);

		const task = await createTask({ repoPath: repo.work, name: "linked" });

		const copied = join(task.worktreePath, "supabase", ".temp", "project-ref");
		expect(existsSync(copied)).toBe(true);
		expect(await Bun.file(copied).text()).toBe("abcdefghijklmnopqrst");
	});

	it("creates the worktree fine when there is no Supabase link", async () => {
		// No supabase/.temp in the repo — task creation must still succeed.
		const task = await createTask({ repoPath: repo.work, name: "unlinked" });
		expect(existsSync(task.worktreePath)).toBe(true);
		expect(existsSync(join(task.worktreePath, "supabase"))).toBe(false);
	});

	it("copies root and nested env files into the new worktree", async () => {
		// Gitignored local secrets that don't ride along on the branch.
		await writeFile(join(repo.work, ".env"), "ROOT=1\n");
		await writeFile(join(repo.work, ".env.local"), "LOCAL=1\n");
		await mkdir(join(repo.work, "apps", "api"), { recursive: true });
		await writeFile(join(repo.work, "apps", "api", ".dev.vars"), "API=2\n");
		// Template files are tracked already — must NOT be copied as a secret.
		await writeFile(join(repo.work, ".env.example"), "ROOT=\n");

		const task = await createTask({ repoPath: repo.work, name: "envy" });

		expect(await Bun.file(join(task.worktreePath, ".env")).text()).toBe(
			"ROOT=1\n",
		);
		expect(await Bun.file(join(task.worktreePath, ".env.local")).text()).toBe(
			"LOCAL=1\n",
		);
		expect(
			await Bun.file(
				join(task.worktreePath, "apps", "api", ".dev.vars"),
			).text(),
		).toBe("API=2\n");
		expect(existsSync(join(task.worktreePath, ".env.example"))).toBe(false);
	});

	it("creates the worktree fine when there are no env files", async () => {
		const task = await createTask({ repoPath: repo.work, name: "no-env" });
		expect(existsSync(task.worktreePath)).toBe(true);
		expect(existsSync(join(task.worktreePath, ".env"))).toBe(false);
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

describe("initRepository — create a repository here instead", () => {
	it("turns a plain folder into a usable repo (init + gitignore + commit)", async () => {
		const plain = await mkdtemp(join(repo.dir, "plain-"));
		await Bun.write(join(plain, "app.ts"), "console.log('hi')\n");

		await initRepository(plain);

		const info = await registerProject(plain);
		expect(info.defaultBranch).toBe("main");
		expect(existsSync(join(plain, ".gitignore"))).toBe(true);
		// The initial commit exists, so tasks/worktrees can branch immediately.
		const task = await createTask({ repoPath: plain, name: "first" });
		expect(existsSync(join(task.worktreePath, "app.ts"))).toBe(true);
	});

	it("keeps an existing .gitignore and refuses to re-init a repo", async () => {
		const plain = await mkdtemp(join(repo.dir, "plain-"));
		await Bun.write(join(plain, ".gitignore"), "custom\n");

		await initRepository(plain);
		expect(await Bun.file(join(plain, ".gitignore")).text()).toBe("custom\n");

		await expect(initRepository(plain)).rejects.toMatchObject({
			code: "ALREADY_A_REPO",
		});
	});
});

describe("detectMerged — external merge detection (no GitHub needed)", () => {
	it("detects a branch merged into origin/main behind Ateam's back", async () => {
		const task = await createTask({ repoPath: repo.work, name: "ext merge" });
		await commitFile(task.worktreePath, "ext.txt", "x\n", "work");
		await push({ worktreePath: task.worktreePath, branch: task.branch });

		// Merge the branch into main remote-side via a throwaway clone — the
		// same end state as `gh pr merge --merge`, which always records a merge
		// commit (--no-ff). Detection keys off that merge commit's parents.
		const clone = await mkdtemp(join(repo.dir, "merge-"));
		await simpleGit().clone(repo.origin, clone);
		const g = simpleGit(clone);
		await g.addConfig("user.email", "tester@ateam.dev");
		await g.addConfig("user.name", "Ateam Tester");
		await g.raw(["fetch", "origin", task.branch]);
		await g.raw(["merge", "--no-ff", "--no-edit", `origin/${task.branch}`]);
		await g.push("origin", "main");

		const res = await detectMerged({
			worktreePath: task.worktreePath,
			branch: task.branch,
			baseBranch: "main",
		});
		expect(res.merged).toBe(true);
	});

	it("reports not-merged while the branch is still ahead of base", async () => {
		const task = await createTask({ repoPath: repo.work, name: "in flight" });
		await commitFile(task.worktreePath, "wip.txt", "w\n", "wip");

		const res = await detectMerged({
			worktreePath: task.worktreePath,
			branch: task.branch,
			baseBranch: "main",
		});
		expect(res.merged).toBe(false);
	});

	it("does NOT mistake a fresh branch with no own commits for a merge", async () => {
		// Regression: containment-based detection flagged brand-new branches as
		// merged (their tip is trivially contained in base).
		const task = await createTask({ repoPath: repo.work, name: "untouched" });

		const res = await detectMerged({
			worktreePath: task.worktreePath,
			branch: task.branch,
			baseBranch: "main",
		});
		expect(res.merged).toBe(false);

		// Still not merged after base advances past the stale branch.
		await advanceOrigin(repo);
		const res2 = await detectMerged({
			worktreePath: task.worktreePath,
			branch: task.branch,
			baseBranch: "main",
		});
		expect(res2.merged).toBe(false);
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

	it("succeeds when the worktree dir was already deleted from disk", async () => {
		const a = await createTask({ repoPath: repo.work, name: "task gone" });

		// Simulate the user deleting the worktree folder out from under us.
		await rm(a.worktreePath, { recursive: true, force: true });

		const res = await removeTask({
			repoPath: repo.work,
			worktreePath: a.worktreePath,
			branch: a.branch,
			deleteBranch: true,
		});

		expect(res.removed).toBe(true);
		expect(res.branchDeleted).toBe(true);

		// The stale worktree admin entry and the branch are both gone.
		const list = parseWorktreeList(
			await simpleGit(repo.work).raw(["worktree", "list", "--porcelain"]),
		);
		expect(list.some((w) => w.branch === a.branch)).toBe(false);
		const branches = await simpleGit(repo.work).raw(["branch", "--list"]);
		expect(branches.includes(a.branch)).toBe(false);
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
