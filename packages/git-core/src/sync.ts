import { gitFor, safeRaw } from "./git-client";

export interface CommitInput {
	worktreePath: string;
	message: string;
	/** Stage everything before committing. Defaults to true. */
	all?: boolean;
}

export async function commit(input: CommitInput): Promise<{ sha: string }> {
	const git = gitFor(input.worktreePath);
	if (input.all !== false) await git.raw(["add", "-A"]);
	await git.raw(["commit", "-m", input.message]);
	const sha = (await git.raw(["rev-parse", "HEAD"])).trim();
	return { sha };
}

export interface PushInput {
	worktreePath: string;
	branch: string;
}

/**
 * Push the worktree's HEAD to `origin/<branch>`, setting upstream on first push.
 * Using the explicit `HEAD:refs/heads/<branch>` refspec avoids ambiguity when
 * no upstream is configured yet.
 */
export async function push(input: PushInput): Promise<void> {
	const git = gitFor(input.worktreePath);
	const refspec = `HEAD:refs/heads/${input.branch}`;
	try {
		await git.raw(["push", "--set-upstream", "origin", refspec]);
	} catch {
		// Fallback for remotes that reject --set-upstream re-runs.
		await git.raw(["push", "origin", refspec]);
	}
}

export interface TrackingStatus {
	ahead: number;
	behind: number;
}

/** Ahead/behind counts vs the configured upstream, or null if no upstream. */
export async function trackingStatus(
	worktreePath: string,
): Promise<TrackingStatus | null> {
	const git = gitFor(worktreePath);
	try {
		const out = (
			await git.raw([
				"rev-list",
				"--left-right",
				"--count",
				"@{upstream}...HEAD",
			])
		).trim();
		const [behind, ahead] = out.split(/\s+/).map((n) => Number.parseInt(n, 10));
		return { ahead: ahead ?? 0, behind: behind ?? 0 };
	} catch {
		return null;
	}
}

export interface UpdateFromBaseInput {
	worktreePath: string;
	baseBranch: string;
	strategy: "merge" | "rebase";
}

export interface UpdateResult {
	status: "clean" | "conflicts";
	conflicts: string[];
}

/**
 * Bring the latest base branch INTO this task branch, operating only inside the
 * task's worktree. `fetch` updates only `refs/remotes/origin/*` (never a local
 * branch or another worktree's working tree); the merge/rebase mutates only
 * this worktree.
 */
export async function updateFromBase(
	input: UpdateFromBaseInput,
): Promise<UpdateResult> {
	const git = gitFor(input.worktreePath);
	await git.raw(["fetch", "origin", input.baseBranch]);
	try {
		if (input.strategy === "rebase") {
			await git.raw(["rebase", `origin/${input.baseBranch}`]);
		} else {
			await git.raw(["merge", "--no-edit", `origin/${input.baseBranch}`]);
		}
		return { status: "clean", conflicts: [] };
	} catch (err) {
		const conflicts = await listConflicts(input.worktreePath);
		if (conflicts.length > 0) return { status: "conflicts", conflicts };
		throw err;
	}
}

async function listConflicts(worktreePath: string): Promise<string[]> {
	const git = gitFor(worktreePath);
	const out = await safeRaw(git, ["diff", "--name-only", "--diff-filter=U"]);
	return out
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
}
