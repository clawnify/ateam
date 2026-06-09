import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { gitFor, refExists } from "./git-client";
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
