import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { gitFor, refExists, safeRaw } from "./git-client";
import { GitCoreError } from "./errors";
import { detectDefaultBranch, ensureWorktreesIgnored } from "./project";
import { slugify } from "./util";
import { safeResolveWorktreePath } from "./worktree-paths";

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
 * Best-effort refresh of `origin/<baseBranch>` so a new task starts from the
 * latest base, not whatever was last fetched. Ignores failures (no remote,
 * offline, branch not on origin) — `resolveStartPoint` then falls back to the
 * local base branch or HEAD.
 */
async function fetchBase(repoPath: string, baseBranch: string): Promise<void> {
	await safeRaw(gitFor(repoPath), ["fetch", "origin", baseBranch]);
}

/** Resolve the start point for a new task branch: prefer the pushed base. */
async function resolveStartPoint(
	repoPath: string,
	baseBranch: string,
): Promise<string> {
	const git = gitFor(repoPath);
	if (await refExists(git, `refs/remotes/origin/${baseBranch}`)) {
		return `origin/${baseBranch}`;
	}
	if (await refExists(git, `refs/heads/${baseBranch}`)) {
		return baseBranch;
	}
	return "HEAD";
}

/**
 * Create a task = a new branch checked out into its own co-located worktree.
 *
 * Safety: `git worktree add -b` creates the branch and checks it out into the
 * NEW directory only. The main worktree's HEAD/working tree is never touched,
 * and we never `checkout` a different branch inside an existing worktree.
 */
export async function createTask(input: CreateTaskInput): Promise<TaskInfo> {
	const slug = slugify(input.name);
	if (!slug) {
		throw new GitCoreError(
			"INVALID_NAME",
			`Task name produced an empty slug: "${input.name}"`,
		);
	}
	const branch = input.branch ?? slug;
	const baseBranch =
		input.baseBranch ?? (await detectDefaultBranch(input.repoPath));
	const worktreePath = safeResolveWorktreePath(
		input.repoPath,
		slug,
		input.worktreesRoot,
	);

	const git = gitFor(input.repoPath);
	// Pull the latest base from origin before branching so the task isn't built
	// on a stale snapshot.
	await fetchBase(input.repoPath, baseBranch);
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
	await git.raw(args);

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

	await git.raw(["worktree", "prune"]).catch(() => {});

	return { removed: true, branchDeleted, warnings };
}
