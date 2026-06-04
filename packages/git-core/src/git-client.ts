import simpleGit, {
	type SimpleGit,
	type SimpleGitOptions,
} from "simple-git";
import { USER_GIT_ENV_SIMPLE_GIT_OPTIONS } from "./simple-git-options";

const BASE_OPTIONS =
	USER_GIT_ENV_SIMPLE_GIT_OPTIONS satisfies Partial<SimpleGitOptions>;

/**
 * A simple-git instance scoped to a single working directory.
 *
 * `GIT_OPTIONAL_LOCKS=0` is the load-bearing detail for a multi-worktree tool:
 * the kanban/diff views poll `git status` across many worktrees while agents
 * are mid-write. Without it, a status read can take or wait on `index.lock`
 * and stall. Every git invocation in git-core goes through here so no worktree
 * can contend on another's locks.
 */
export function gitFor(worktreePath: string): SimpleGit {
	return simpleGit(worktreePath, BASE_OPTIONS).env({
		...process.env,
		GIT_OPTIONAL_LOCKS: "0",
	});
}

/** Run a git command, returning "" instead of throwing (for best-effort reads). */
export async function safeRaw(git: SimpleGit, args: string[]): Promise<string> {
	try {
		return await git.raw(args);
	} catch {
		return "";
	}
}

/** Returns true if a ref exists, false otherwise (never throws). */
export async function refExists(git: SimpleGit, ref: string): Promise<boolean> {
	try {
		// `--quiet` exits 1 with NO stderr on a missing ref, which simple-git
		// reports as success — so the answer must come from stdout (the sha).
		const out = await git.raw(["rev-parse", "--verify", "--quiet", ref]);
		return out.trim().length > 0;
	} catch {
		return false;
	}
}
