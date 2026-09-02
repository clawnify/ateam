import { existsSync } from "node:fs";
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { SimpleGit } from "simple-git";
import { gitFor, refExists } from "./git-client";
import { GitCoreError } from "./errors";
import { detectDefaultBranch, ensureWorktreesIgnored } from "./project";
import { slugify } from "./util";
import { safeResolveWorktreePath, worktreesRootFor } from "./worktree-paths";

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
async function resolveStartPoint(
	repoPath: string,
	baseBranch: string,
): Promise<string> {
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
			worktreePath: safeResolveWorktreePath(
				repoPath,
				slug + suffix,
				worktreesRoot,
			),
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
async function copySupabaseLink(
	repoPath: string,
	worktreePath: string,
): Promise<void> {
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

/** Directories never worth descending into when hunting for env files. */
const SKIP_DIRS = new Set([".git", "node_modules"]);

/**
 * Local secrets/config live in gitignored env files — `.env` (and variants like
 * `.env.local`) and Cloudflare's `.dev.vars` — that don't ride along on the
 * branch, so a fresh worktree can't run the app until they're present. Copy them
 * across, including nested ones (e.g. `apps/api/.dev.vars`), preserving their
 * relative location. Template files (`.env.example` & co.) are tracked already,
 * so we skip them. Best-effort: any walk/copy error must never fail task
 * creation.
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

async function copyEnvFiles(
	repoPath: string,
	worktreePath: string,
	worktreesRoot?: string | null,
): Promise<void> {
	const root = worktreesRootFor(repoPath, worktreesRoot);

	async function walk(dir: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const abs = join(dir, entry.name);
			if (abs === root) continue; // don't descend into other worktrees
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) continue;
				await walk(abs);
			} else if (entry.isFile() && isEnvFile(entry.name)) {
				const dest = join(worktreePath, relative(repoPath, abs));
				try {
					await mkdir(dirname(dest), { recursive: true });
					await cp(abs, dest);
				} catch {
					/* best-effort — skip this file */
				}
			}
		}
	}

	await walk(repoPath);
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
		throw new GitCoreError(
			"INVALID_NAME",
			`Task name produced an empty slug: "${input.name}"`,
		);
	}
	const baseBranch =
		input.baseBranch ?? (await detectDefaultBranch(input.repoPath));

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
	await git.raw([
		"worktree",
		"add",
		"--no-track",
		"-b",
		branch,
		worktreePath,
		startPoint,
	]);

	// Record the base branch so update/merge know what to diff/merge against.
	await gitFor(worktreePath).raw(["config", `branch.${branch}.base`, baseBranch]);

	// Carry the Supabase link over so the worktree's CLI is already linked.
	await copySupabaseLink(input.repoPath, worktreePath);

	// Carry gitignored env files (.env*, .dev.vars*) over, including nested ones,
	// so the worktree can run the app without re-creating its local secrets.
	await copyEnvFiles(input.repoPath, worktreePath, input.worktreesRoot);

	return { slug, branch, baseBranch, worktreePath };
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

export async function removeTask(
	input: RemoveTaskInput,
): Promise<RemoveTaskResult> {
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
		if (!/is not a working tree|No such file or directory/i.test(message)) {
			throw err;
		}
		warnings.push(
			`Worktree "${input.worktreePath}" was already gone; pruned its stale entry.`,
		);
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
