import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import simpleGit from "simple-git";
import { GitCoreError } from "../src/errors";
import {
	cloneRepo,
	commit,
	createTask,
	detectDefaultBranch,
	detectMerged,
	diff,
	initRepository,
	parseGithubRepo,
	parseWorktreeList,
	push,
	registerProject,
	removeTask,
	safeResolveWorktreePath,
	seedWorktree,
	slugify,
	updateFromBase,
	updateLocalMain,
} from "../src/index";
import { advanceOrigin, commitFile, makeTempRepoPair, type TempRepo } from "./helpers/temp-repo";

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
		const exclude = await Bun.file(join(repo.work, ".git", "info", "exclude")).text();
		expect(exclude).toContain("/.ateam/");
	});

	it("throws NOT_A_REPO for a non-repo path", async () => {
		await expect(registerProject(repo.dir)).rejects.toMatchObject({
			code: "NOT_A_REPO",
		});
	});
});

// This parse IS the cross-engine identity: the same repo cloned on a Mac and on a
// box is reconciled into one board card by the owner/name read out of each clone's
// origin URL. Two clones of one repo routinely disagree on scheme AND on casing, so
// every shape below has to land on the same pair.
describe("parseGithubRepo", () => {
	const cases: [string, { owner: string; name: string } | null][] = [
		["https://github.com/clawnify/ateam.git", { owner: "clawnify", name: "ateam" }],
		["https://github.com/clawnify/ateam", { owner: "clawnify", name: "ateam" }],
		["https://github.com/clawnify/ateam/", { owner: "clawnify", name: "ateam" }],
		["git@github.com:clawnify/ateam.git", { owner: "clawnify", name: "ateam" }],
		["ssh://git@github.com/clawnify/ateam.git", { owner: "clawnify", name: "ateam" }],
		// Casing is preserved here and folded by the consumer, so BOTH real spellings
		// of this repo survive the parse rather than one of them being lost.
		["https://github.com/clawnify/TaskWindow.git", { owner: "clawnify", name: "TaskWindow" }],
		["https://github.com/clawnify/taskwindow.git", { owner: "clawnify", name: "taskwindow" }],
		// Dots and dashes are legal in both halves.
		["https://github.com/my-org/my.repo.git", { owner: "my-org", name: "my.repo" }],
		// Not GitHub: no identity rather than a wrong one, so these stay their own card.
		["https://gitlab.com/clawnify/ateam.git", null],
		["git@bitbucket.org:clawnify/ateam.git", null],
		["/srv/git/bare.git", null],
		["", null],
	];
	for (const [url, want] of cases) {
		it(`parses ${url || "(empty)"}`, () => {
			expect(parseGithubRepo(url)).toEqual(want);
		});
	}
});

describe("createTask freshness", () => {
	it("branches off the latest origin/<base>, not a stale cached ref", async () => {
		// The clone's refs/remotes/origin/main is now behind the real remote --
		// exactly the state a repo sits in between merges.
		const advanced = await advanceOrigin(repo);
		expect(await branchSha(repo.work, "refs/remotes/origin/main")).not.toBe(advanced);

		const task = await createTask({ repoPath: repo.work, name: "fresh" });

		expect(await headSha(task.worktreePath)).toBe(advanced);
	});

	it("still creates the task when the remote is unreachable", async () => {
		const advanced = await advanceOrigin(repo);
		const cached = await branchSha(repo.work, "refs/remotes/origin/main");
		await simpleGit(repo.work).raw([
			"remote",
			"set-url",
			"origin",
			join(repo.dir, "does-not-exist.git"),
		]);

		const task = await createTask({ repoPath: repo.work, name: "offline" });

		// Falls back to the cached ref instead of failing: creating a task must
		// never require the network.
		expect(await headSha(task.worktreePath)).toBe(cached);
		expect(cached).not.toBe(advanced);
	});
});

describe("createTask isolation", () => {
	/**
	 * A real "create a task" is both calls: createTask makes the worktree, and
	 * seedWorktree carries the gitignored state it needs to RUN. They are split
	 * so the task's row (and its card) can exist before the slow half finishes.
	 */
	async function createAndSeed(name: string) {
		const task = await createTask({ repoPath: repo.work, name });
		await seedWorktree({
			repoPath: repo.work,
			worktreePath: task.worktreePath,
		});
		return task;
	}

	it("creates a co-located worktree without disturbing the main worktree", async () => {
		const headBefore = await simpleGit(repo.work).raw(["symbolic-ref", "HEAD"]);
		const statusBefore = await porcelainStatus(repo.work);

		const task = await createTask({ repoPath: repo.work, name: "Add auth" });

		expect(task.slug).toBe("add-auth");
		expect(task.branch).toBe("add-auth");
		expect(task.baseBranch).toBe("main");
		expect(task.worktreePath).toBe(join(repo.work, ".ateam", "worktrees", "add-auth"));
		expect(existsSync(task.worktreePath)).toBe(true);

		// Main worktree HEAD + working tree byte-for-byte unchanged.
		expect(await simpleGit(repo.work).raw(["symbolic-ref", "HEAD"])).toBe(headBefore);
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
		await writeFile(join(repo.work, "supabase", ".temp", "project-ref"), "abcdefghijklmnopqrst");

		const task = await createAndSeed("linked");

		const copied = join(task.worktreePath, "supabase", ".temp", "project-ref");
		expect(existsSync(copied)).toBe(true);
		expect(await Bun.file(copied).text()).toBe("abcdefghijklmnopqrst");
	});

	it("creates the worktree fine when there is no Supabase link", async () => {
		// No supabase/.temp in the repo — task creation must still succeed.
		const task = await createAndSeed("unlinked");
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

		const task = await createAndSeed("envy");

		expect(await Bun.file(join(task.worktreePath, ".env")).text()).toBe("ROOT=1\n");
		expect(await Bun.file(join(task.worktreePath, ".env.local")).text()).toBe("LOCAL=1\n");
		expect(await Bun.file(join(task.worktreePath, "apps", "api", ".dev.vars")).text()).toBe(
			"API=2\n",
		);
		expect(existsSync(join(task.worktreePath, ".env.example"))).toBe(false);
	});

	it("seeds every node_modules into the new worktree, symlinks verbatim", async () => {
		// A monorepo keeps a tree per package, and package stores link between
		// them RELATIVELY. A copy that rewrites those links to absolute paths
		// would point the new worktree back at the source repo.
		await writeFile(join(repo.work, ".gitignore"), "node_modules/\n");
		await mkdir(join(repo.work, "node_modules", ".store", "dep"), {
			recursive: true,
		});
		await writeFile(
			join(repo.work, "node_modules", ".store", "dep", "index.js"),
			"module.exports = 1;\n",
		);
		await symlink(join(".store", "dep"), join(repo.work, "node_modules", "dep"));
		await mkdir(join(repo.work, "apps", "web", "node_modules"), {
			recursive: true,
		});
		await symlink(
			join("..", "..", "..", "node_modules", ".store", "dep"),
			join(repo.work, "apps", "web", "node_modules", "dep"),
		);

		const task = await createAndSeed("seeded");

		expect(
			await Bun.file(join(task.worktreePath, "node_modules", ".store", "dep", "index.js")).text(),
		).toBe("module.exports = 1;\n");
		// The nested tree is cloned too, not just the root one.
		expect(existsSync(join(task.worktreePath, "apps", "web", "node_modules"))).toBe(true);
		// And both links still point where they did, relatively.
		expect(await readlink(join(task.worktreePath, "node_modules", "dep"))).toBe(
			join(".store", "dep"),
		);
		expect(await readlink(join(task.worktreePath, "apps", "web", "node_modules", "dep"))).toBe(
			join("..", "..", "..", "node_modules", ".store", "dep"),
		);
	});

	it("stages dependencies outside the worktree and leaves no scrap behind", async () => {
		// The copy takes ~25s on a real monorepo and the agent no longer waits for
		// it, so a tree copied in place would be visible half-populated — worse
		// than absent, because a partial `node_modules` fails in ways that look
		// like the code's fault. Staging out of tree and renaming in makes the
		// worktree show absent or complete and nothing else.
		await writeFile(join(repo.work, ".gitignore"), "node_modules/\n");
		await mkdir(join(repo.work, "node_modules", "pkg"), { recursive: true });
		await writeFile(join(repo.work, "node_modules", "pkg", "i.js"), "dep\n");

		const task = await createAndSeed("staged");

		// Landed complete...
		expect(await Bun.file(join(task.worktreePath, "node_modules", "pkg", "i.js")).text()).toBe(
			"dep\n",
		);
		// ...and the staging directory, a sibling of the worktree, is gone.
		const worktreesRoot = join(repo.work, ".ateam", "worktrees");
		const leftovers = (await readdir(worktreesRoot)).filter((n) => n.startsWith(".seeding-"));
		expect(leftovers).toEqual([]);
	});

	it("never descends into a nested checkout when seeding", async () => {
		// Another tool's worktrees, or a vendored clone, living inside the repo.
		// Its dependencies and secrets belong to IT, not to this task, and a
		// directory walk cannot tell it has left the repo — which is how 370
		// node_modules trees and 28 unrelated .env files ended up in every new
		// worktree. `git ls-files` stops at the boundary; that is the fix.
		await writeFile(join(repo.work, ".gitignore"), "node_modules/\n");
		await mkdir(join(repo.work, "node_modules", "own"), { recursive: true });
		await writeFile(join(repo.work, "node_modules", "own", "i.js"), "mine\n");
		await writeFile(join(repo.work, ".env"), "MINE=1\n");

		const nested = join(repo.work, "vendor", "other");
		await mkdir(nested, { recursive: true });
		await simpleGit().raw(["init", "-b", "main", nested]);
		await mkdir(join(nested, "node_modules", "theirs"), { recursive: true });
		await writeFile(join(nested, "node_modules", "theirs", "i.js"), "theirs\n");
		await writeFile(join(nested, ".env"), "THEIRS=1\n");

		const task = await createAndSeed("boundary");

		// This repo's own state came across.
		expect(existsSync(join(task.worktreePath, "node_modules", "own"))).toBe(true);
		expect(await Bun.file(join(task.worktreePath, ".env")).text()).toBe("MINE=1\n");
		// The nested checkout's did not — neither its deps nor its secrets.
		expect(existsSync(join(task.worktreePath, "vendor", "other", "node_modules"))).toBe(false);
		expect(existsSync(join(task.worktreePath, "vendor", "other", ".env"))).toBe(false);
	});

	it("creates the worktree fine when nothing is installed", async () => {
		const task = await createAndSeed("no-deps");
		expect(existsSync(task.worktreePath)).toBe(true);
		expect(existsSync(join(task.worktreePath, "node_modules"))).toBe(false);
	});

	it("creates the worktree fine when there are no env files", async () => {
		const task = await createAndSeed("no-env");
		expect(existsSync(task.worktreePath)).toBe(true);
		expect(existsSync(join(task.worktreePath, ".env"))).toBe(false);
	});
	it("allows several tasks with the same name", async () => {
		const a = await createTask({ repoPath: repo.work, name: "same name" });
		const b = await createTask({ repoPath: repo.work, name: "same name" });
		const c = await createTask({ repoPath: repo.work, name: "Same Name!" });

		expect([a.branch, b.branch, c.branch]).toEqual(["same-name", "same-name-2", "same-name-3"]);
		expect([a.slug, b.slug, c.slug]).toEqual(["same-name", "same-name-2", "same-name-3"]);
		for (const t of [a, b, c]) expect(existsSync(t.worktreePath)).toBe(true);
	});

	it("skips a name whose branch survived an earlier task", async () => {
		// Task removed, branch kept (deleteBranch not requested) — the classic
		// "a branch named X already exists" failure.
		const first = await createTask({ repoPath: repo.work, name: "leftover" });
		await removeTask({
			repoPath: repo.work,
			worktreePath: first.worktreePath,
			branch: first.branch,
		});

		const second = await createTask({ repoPath: repo.work, name: "leftover" });
		expect(second.branch).toBe("leftover-2");
		expect(existsSync(second.worktreePath)).toBe(true);
	});

	it("skips a name already taken by a remote branch", async () => {
		await simpleGit(repo.work).raw(["update-ref", "refs/remotes/origin/taken", "HEAD"]);

		const task = await createTask({ repoPath: repo.work, name: "taken" });
		expect(task.branch).toBe("taken-2");
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
		const localSha = await commitFile(repo.work, "local.txt", "local\n", "divergent local commit");
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
	it("refuses a dirty worktree instead of deleting it behind git's back", async () => {
		const task = await createTask({ repoPath: repo.work, name: "dirty" });
		await writeFile(join(task.worktreePath, "scratch.txt"), "unsaved\n");

		// removeTask has a rescue path that deletes the directory itself, but it
		// is armed ONLY for git being KILLED mid-removal (the inactivity timeout
		// on a huge worktree). git REFUSING is a different thing entirely, and
		// widening the rescue to cover it would turn every guarded removal into a
		// forced one and destroy uncommitted work.
		await expect(
			removeTask({
				repoPath: repo.work,
				worktreePath: task.worktreePath,
				branch: task.branch,
			}),
		).rejects.toThrow();
		expect(existsSync(join(task.worktreePath, "scratch.txt"))).toBe(true);
	});

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
		expect(() => safeResolveWorktreePath("/repo", "../../evil")).toThrow(GitCoreError);
	});

	it("slugify neutralizes traversal characters", () => {
		expect(slugify("../../evil")).toBe("evil");
		expect(slugify("Add Auth!!")).toBe("add-auth");
	});
});

describe("cloneRepo — gh fallback (no GitHub needed)", () => {
	const GH_URL = "https://github.com/acme/demo.git";
	let savedEnv: Record<string, string | undefined>;

	// A fake `gh` that always fails (an unauthenticated gh, e.g. an engine
	// process on a boxd box, where GH_TOKEN only exists in login shells), plus a
	// git URL rewrite so the fallback `git clone` resolves to the local bare
	// origin instead of the network.
	beforeEach(async () => {
		const bin = join(repo.dir, "fake-bin");
		await mkdir(bin);
		await writeFile(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
		await chmod(join(bin, "gh"), 0o755);
		savedEnv = {
			PATH: process.env.PATH,
			GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
			GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
			GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
		};
		process.env.PATH = `${bin}:${process.env.PATH}`;
		process.env.GIT_CONFIG_COUNT = "1";
		process.env.GIT_CONFIG_KEY_0 = `url.${repo.origin}.insteadOf`;
		process.env.GIT_CONFIG_VALUE_0 = GH_URL;
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("falls back to plain git clone when gh fails", async () => {
		const dest = join(repo.dir, "cloned");
		await cloneRepo(GH_URL, dest);
		expect(existsSync(join(dest, "README.md"))).toBe(true);
	});

	it("throws GH_FAILED when git fails too", async () => {
		process.env.GIT_CONFIG_KEY_0 = `url.${join(repo.dir, "nowhere.git")}.insteadOf`;
		await expect(cloneRepo(GH_URL, join(repo.dir, "cloned"))).rejects.toMatchObject({
			code: "GH_FAILED",
		});
	});
});
