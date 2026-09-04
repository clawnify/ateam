import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { SimpleGit } from "simple-git";
import { GitCoreError } from "./errors";
import { gitFor, refExists, safeRaw } from "./git-client";
import { detectDefaultBranch, ensureWorktreesIgnored } from "./project";
import { slugify } from "./util";
import { safeResolveWorktreePath } from "./worktree-paths";

const pexec = promisify(execFile);

export interface CreateTaskInput {
	repoPath: string;
	name: string;
	/** Branch to base the task off. Defaults to the repo's default branch. */
	baseBranch?: string;
	/** Override the worktrees root (defaults to `<repo>/.worktrees`). */
	worktreesRoot?: string | null;
	/** Explicit branch name. Defaults to the slug of `name`. */
	branch?: string;
}

export interface TaskInfo {
	slug: string;
	branch: string;
	baseBranch: string;
	worktreePath: string;
}

/**
 * Wall-clock budget for the pre-flight fetch. Freshness here is best-effort, so
 * the cap is what an interactive "create task" click can absorb, not how long a
 * fetch might legitimately take.
 */
const FETCH_TIMEOUT_MS = 5_000;

/**
 * Refresh `refs/remotes/origin/<base>` before we branch off it.
 *
 * That ref is a LOCAL CACHE, and nothing on this path used to update it: the
 * only fetches in git-core are in `updateFromBase` and the merge flow, so the
 * cache went stale until someone happened to merge or hit "update from base".
 * Merges that land elsewhere (the GitHub UI, another clone, a teammate) are
 * invisible here by construction, so no amount of reacting to our own merges
 * can keep it warm. Fetching at the moment of use is the only formulation that
 * doesn't depend on having witnessed the write.
 *
 * Best-effort, never required: offline, no remote, or a headless box with no
 * credentials all fall through to the chain below (cached ref, then the local
 * branch, then HEAD). Creating a task must never need the network.
 *
 * The bare `fetch origin <base>` refspec writes only `refs/remotes/origin/*` --
 * never a local branch, never any worktree's checkout. (Contrast the
 * `<base>:<base>` form in merge.ts, which does write a local branch and leans
 * on git's own "checked out" refusal to stay safe.) Killing it mid-flight is
 * safe too: refs are written at the end, so the worst case is a temp packfile
 * that gc reclaims.
 *
 * One measured caveat: aborting kills `git`, but its `git-remote-https` child
 * survives, orphaned, until the OS gives up on the TCP connect (~75s on macOS).
 * The caller is already unblocked at FETCH_TIMEOUT_MS, and the strays are idle
 * and self-reaping -- git exposes no connect timeout (only http.lowSpeed*,
 * which covers transfer rate, not connect), so bounding it any tighter would
 * mean bypassing simple-git entirely for this one call.
 */
async function fetchBase(repoPath: string, baseBranch: string): Promise<void> {
	try {
		await gitFor(repoPath, {
			abort: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		}).raw(["fetch", "origin", baseBranch]);
	} catch {
		/* best-effort -- branch off whatever ref we already have */
	}
}

/** Resolve the start point for a new task branch: prefer the pushed base. */
async function resolveStartPoint(repoPath: string, baseBranch: string): Promise<string> {
	const git = gitFor(repoPath);
	await fetchBase(repoPath, baseBranch);
	if (await refExists(git, `refs/remotes/origin/${baseBranch}`)) {
		return `origin/${baseBranch}`;
	}
	if (await refExists(git, `refs/heads/${baseBranch}`)) {
		return baseBranch;
	}
	return "HEAD";
}

/** Give up after this many suffixed variants (guards against a pathological repo). */
const MAX_NAME_ATTEMPTS = 100;

/**
 * Pick the first free `slug`/`branch`/worktree triple: `slug`, then `slug-2`,
 * `slug-3`, ... A repeated task name is normal (two prompts that summarize to
 * the same title, or a branch that outlived a removed task), so it must never
 * surface `git worktree add -b` refusing an existing branch. "Free" means no
 * directory at the worktree path, no local branch, and no `origin/` branch.
 */
async function allocateNames(
	git: SimpleGit,
	repoPath: string,
	slug: string,
	branch: string,
	worktreesRoot: string | null | undefined,
): Promise<{ slug: string; branch: string; worktreePath: string }> {
	for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++) {
		const suffix = n === 1 ? "" : `-${n}`;
		const candidate = {
			slug: slug + suffix,
			branch: branch + suffix,
			worktreePath: safeResolveWorktreePath(repoPath, slug + suffix, worktreesRoot),
		};
		if (existsSync(candidate.worktreePath)) continue;
		if (await refExists(git, `refs/heads/${candidate.branch}`)) continue;
		if (await refExists(git, `refs/remotes/origin/${candidate.branch}`)) continue;
		return candidate;
	}
	throw new GitCoreError(
		"INVALID_NAME",
		`Could not find a free branch/worktree name for "${slug}" after ${MAX_NAME_ATTEMPTS} attempts`,
	);
}

/**
 * Supabase's project link lives in `supabase/.temp/` (gitignored — it holds the
 * `project-ref` and cached versions written by `supabase link`). The tracked
 * `supabase/` config rides along on the branch, but `.temp` does not, so a fresh
 * worktree's CLI would be unlinked. Copy that untracked link state across so the
 * CLI in the new worktree is already linked. Best-effort: a missing source dir,
 * a non-Supabase repo, or a copy error must never fail task creation.
 */
async function copySupabaseLink(repoPath: string, worktreePath: string): Promise<void> {
	const src = join(repoPath, "supabase", ".temp");
	try {
		if (!(await stat(src)).isDirectory()) return;
	} catch {
		return; // no Supabase link in the source repo — nothing to copy
	}
	try {
		await cp(src, join(worktreePath, "supabase", ".temp"), {
			recursive: true,
		});
	} catch {
		/* best-effort — leave the worktree unlinked rather than fail the task */
	}
}

/**
 * What is in this working tree but NOT on the branch: its ignored and untracked
 * entries. Everything the seed carries across is one of these by definition —
 * git refuses to put them on the branch, which is precisely why a fresh worktree
 * cannot run until something copies them.
 *
 * `git ls-files` rather than a hand-rolled directory walk, for two properties a
 * walk cannot reproduce:
 *
 *  - It never crosses a repository boundary. A nested checkout — another tool's
 *    worktrees (`.claude/worktrees`), a vendored clone, a submodule — is
 *    reported as a single entry whose contents are never listed, whether or not
 *    it is gitignored. A walk has no idea it has left this repo, so it descends
 *    and copies that repo's dependencies and secrets into the new worktree:
 *    measured on one monorepo, 370 `node_modules` trees instead of 11, and 28
 *    `.env`/`.dev.vars` files belonging to six unrelated checkouts.
 *  - It owns ignore semantics — `.gitignore` at every level, `.git/info/exclude`
 *    (where ensureWorktreesIgnored puts our own worktrees root), the user's
 *    global excludes — so the worktrees root needs no special-casing here.
 *
 * Two invocations, answering different questions:
 *  - ignored, WITH `--directory`: collapses a wholly-ignored tree to one entry,
 *    so `node_modules/` arrives as a single path instead of 114k files.
 *  - untracked-but-not-ignored, WITHOUT `--directory`: a repo that does not
 *    gitignore its `.env` still needs it carried, and there the individual files
 *    are what we want. Nested repos stay collapsed either way.
 *
 * Tracked files appear in neither, which is correct: they ride the branch, and
 * copying them would clobber the checkout with the source worktree's version.
 *
 * `-z` because `ls-files` otherwise C-quotes any path with non-ASCII bytes.
 */
async function listUnversionedEntries(repoPath: string): Promise<string[]> {
	const git = gitFor(repoPath);
	const [ignored, untracked] = await Promise.all([
		safeRaw(git, ["ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory"]),
		safeRaw(git, ["ls-files", "-z", "-o", "--exclude-standard"]),
	]);
	const entries = new Set<string>();
	for (const raw of `${ignored}\0${untracked}`.split("\0")) {
		const entry = raw.replace(/\/$/, "").trim();
		if (entry) entries.add(entry);
	}
	return [...entries];
}

/**
 * Local secrets/config live in env files — `.env` (and variants like
 * `.env.local`) and Cloudflare's `.dev.vars` — that don't ride along on the
 * branch, so a fresh worktree can't run the app until they're present. Template
 * files (`.env.example` & co.) are tracked already, so we skip them.
 */
function isEnvFile(name: string): boolean {
	if (/\.(example|sample|template)$/.test(name)) return false;
	return (
		name === ".env" ||
		name.startsWith(".env.") ||
		name === ".dev.vars" ||
		name.startsWith(".dev.vars.")
	);
}

/** Copy this repo's own env files across, preserving their relative location. */
async function copyEnvFiles(
	repoPath: string,
	worktreePath: string,
	entries: string[],
): Promise<void> {
	for (const rel of entries) {
		if (!isEnvFile(basename(rel))) continue;
		try {
			if (!(await stat(join(repoPath, rel))).isFile()) continue;
			const dest = join(worktreePath, rel);
			await mkdir(dirname(dest), { recursive: true });
			await cp(join(repoPath, rel), dest);
		} catch {
			/* best-effort — skip this file */
		}
	}
}

/**
 * Copy-on-write copy: share blocks with the source instead of duplicating them.
 * macOS `cp -c` is clonefile(2); GNU `cp --reflink=auto` reflinks on btrfs/XFS
 * and silently falls back to a full copy elsewhere rather than failing.
 *
 * Measured ceiling: this is per-file, so a 1.3 GB / 114k-file `node_modules`
 * costs ~35s. Darwin's clonefile(2) applied to the DIRECTORY does the same work
 * in ~3.7s, but it has no Node binding and no Linux equivalent, and the engine
 * also runs on Linux boxes. Revisit only if seeding ever blocks task creation
 * again — today it does not, seedWorktree runs after the task row exists.
 */
const CLONE_CP = process.platform === "darwin" ? "/bin/cp" : "cp";
const CLONE_ARGS = process.platform === "darwin" ? ["-c", "-R"] : ["--reflink=auto", "-R"];

/**
 * Dependencies are gitignored, so a fresh worktree cannot typecheck, lint or run
 * until something installs them — and nothing does. Clone the source repo's
 * `node_modules` across instead, which on a copy-on-write filesystem shares the
 * blocks rather than duplicating them.
 *
 * `fs.cp` is not a substitute — even with COPYFILE_FICLONE it wrote 819 MB for a
 * tree that clones for ~9 MB of real disk — hence shelling out. `verbatim`
 * symlink behaviour matters too: `cp -R` preserves the relative links a bun/pnpm
 * store depends on, while `fs.cp` rewrites them to absolute paths into the
 * SOURCE.
 *
 * The seed also removes the expensive half of any later install: Electron's
 * postinstall exits early once `dist/version` matches, so its 244 MB download
 * and extract never runs in this worktree.
 *
 * Monorepos keep a `node_modules` per package, so every tree THIS repo owns is
 * cloned, not just the root one.
 */
async function seedNodeModules(
	repoPath: string,
	worktreePath: string,
	entries: string[],
): Promise<void> {
	for (const rel of entries) {
		if (basename(rel) !== "node_modules") continue;
		const dest = join(worktreePath, rel);
		try {
			await mkdir(dirname(dest), { recursive: true });
			await pexec(CLONE_CP, [...CLONE_ARGS, join(repoPath, rel), dest]);
		} catch {
			/* best-effort — the worktree just needs its own install */
		}
	}
}

/**
 * Create a task = a new branch checked out into its own co-located worktree.
 *
 * Safety: `git worktree add -b` creates the branch and checks it out into the
 * NEW directory only. The main worktree's HEAD/working tree is never touched,
 * and we never `checkout` a different branch inside an existing worktree.
 */
export async function createTask(input: CreateTaskInput): Promise<TaskInfo> {
	const baseSlug = slugify(input.name);
	if (!baseSlug) {
		throw new GitCoreError("INVALID_NAME", `Task name produced an empty slug: "${input.name}"`);
	}
	const baseBranch = input.baseBranch ?? (await detectDefaultBranch(input.repoPath));

	const git = gitFor(input.repoPath);
	// A repeated name is normal, not an error: take the next free variant.
	const { slug, branch, worktreePath } = await allocateNames(
		git,
		input.repoPath,
		baseSlug,
		input.branch ?? baseSlug,
		input.worktreesRoot,
	);
	const startPoint = await resolveStartPoint(input.repoPath, baseBranch);

	// Keep co-located worktrees out of the project's own `git status`, even if
	// registerProject was never called for this repo.
	await ensureWorktreesIgnored(input.repoPath, input.worktreesRoot);

	await mkdir(dirname(worktreePath), { recursive: true });
	await git.raw(["worktree", "add", "--no-track", "-b", branch, worktreePath, startPoint]);

	// Record the base branch so update/merge know what to diff/merge against.
	await gitFor(worktreePath).raw(["config", `branch.${branch}.base`, baseBranch]);

	return { slug, branch, baseBranch, worktreePath };
}

export interface SeedWorktreeInput {
	repoPath: string;
	worktreePath: string;
}

/**
 * Carry over the gitignored working-tree state a fresh worktree needs in order
 * to RUN: the Supabase link, env files, and installed dependencies.
 *
 * Deliberately NOT part of createTask, and deliberately not awaited by it. This
 * is the overwhelming majority of the cost — measured on one monorepo, `git
 * worktree add` is ~2s and this is ~52s for 161k files — so gating the task's
 * existence on it means the board shows nothing for a minute, and the user
 * reasonably concludes the click did not register and clicks New task again.
 * The caller creates the row first, announces it, and runs this after; anything
 * that needs the dependencies (launching an agent) awaits it by task id.
 *
 * Every step is best-effort by design: a repo with nothing installed, a
 * filesystem without reflinks, or a copy error leaves a worktree that needs its
 * own install — never a task that failed to be created.
 */
export async function seedWorktree(input: SeedWorktreeInput): Promise<void> {
	const entries = await listUnversionedEntries(input.repoPath);
	// Carry the Supabase link over so the worktree's CLI is already linked.
	await copySupabaseLink(input.repoPath, input.worktreePath);
	// Carry env files (.env*, .dev.vars*) over, including nested ones, so the
	// worktree can run the app without re-creating its local secrets.
	await copyEnvFiles(input.repoPath, input.worktreePath, entries);
	// Carry the installed dependencies over as a copy-on-write clone, so the
	// worktree can typecheck and run immediately instead of paying a full
	// install (and Electron's 244 MB extract) per task.
	await seedNodeModules(input.repoPath, input.worktreePath, entries);
}

export interface RemoveTaskInput {
	repoPath: string;
	worktreePath: string;
	branch: string;
	deleteBranch?: boolean;
	/** Force removal even with uncommitted changes / unmerged branch. */
	force?: boolean;
}

export interface RemoveTaskResult {
	removed: boolean;
	branchDeleted: boolean;
	warnings: string[];
}

/**
 * Delete a worktree's directory ourselves, returning whether it is now gone.
 *
 * `rm -rf` driven by a path out of the database needs a stronger guarantee than
 * "it looks like a worktree path", so the only paths eligible are the ones git
 * itself reports as worktrees of THIS repo, minus the main worktree. That is one
 * command, and it is git's own record rather than our inference from a string.
 */
async function removeWorktreeDirectory(
	git: SimpleGit,
	repoPath: string,
	worktreePath: string,
): Promise<boolean> {
	const target = resolve(worktreePath);
	if (target === resolve(repoPath)) return false;
	const listed = await safeRaw(git, ["worktree", "list", "--porcelain"]);
	const known = listed
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.some((line) => resolve(line.slice("worktree ".length).trim()) === target);
	if (!known) return false;
	try {
		await rm(target, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * simple-git's inactivity killer, verbatim from its timeout plugin. Matching the
 * message is what separates "git was killed mid-removal" from "git refused".
 */
const TIMEOUT_KILL = /block timeout reached/i;

export async function removeTask(input: RemoveTaskInput): Promise<RemoveTaskResult> {
	const git = gitFor(input.repoPath);
	const warnings: string[] = [];

	const args = ["worktree", "remove", input.worktreePath];
	if (input.force) args.push("--force");
	try {
		await git.raw(args);
	} catch (err) {
		// If the worktree directory was deleted out from under us (e.g. removed
		// manually in Finder/the shell), `git worktree remove` fails with
		// "is not a working tree". That's not a real failure for our purposes —
		// the tree is already gone. Prune the stale admin entry below and carry
		// on to branch deletion instead of surfacing the error to the user.
		const message = err instanceof Error ? err.message : String(err);
		if (/is not a working tree|No such file or directory/i.test(message)) {
			warnings.push(`Worktree "${input.worktreePath}" was already gone; pruned its stale entry.`);
		} else if (
			TIMEOUT_KILL.test(message) &&
			(await removeWorktreeDirectory(git, input.repoPath, input.worktreePath))
		) {
			// git was KILLED here, it did not refuse: simple-git's `timeout.block`
			// is an INACTIVITY timer, and `worktree remove` prints nothing at all
			// while it unlinks, so a worktree with seeded dependencies (~161k files)
			// trips it at five minutes with the tree half-deleted. Rethrowing then
			// strands the task — the caller never deletes its row, the card stays on
			// the board pointing at a broken worktree, and every retry dies exactly
			// the same way. Finishing the removal ourselves is what makes a delete
			// the user asked for actually complete.
			//
			// Narrow to that one signature ON PURPOSE. `worktree remove` validates
			// BEFORE it unlinks, so a timeout means the checks already passed and
			// the deletion was underway — safe to finish. Every other failure is git
			// REFUSING (a dirty worktree without --force, a main working tree), and
			// deleting the directory there would silently turn a guarded removal
			// into a forced one and destroy uncommitted work. Those still throw.
			warnings.push(
				`Worktree "${input.worktreePath}" did not remove cleanly (${message}); removed its directory directly.`,
			);
		} else {
			throw err;
		}
	}

	// Prune before deleting the branch: if the worktree dir vanished, git still
	// believes the branch is checked out there and `branch -d` would refuse with
	// "Cannot delete branch ... checked out at ...". Pruning clears that link.
	await git.raw(["worktree", "prune"]).catch(() => {});

	let branchDeleted = false;
	if (input.deleteBranch) {
		try {
			// `branch -d` refuses to delete an unmerged branch; only `-D` forces.
			await git.raw(["branch", input.force ? "-D" : "-d", input.branch]);
			branchDeleted = true;
		} catch (err) {
			warnings.push(
				`Branch "${input.branch}" not deleted (likely unmerged): ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	return { removed: true, branchDeleted, warnings };
}
