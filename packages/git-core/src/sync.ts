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

/**
 * Entries `git status --porcelain` lists: modified, staged and untracked paths
 * (an untracked folder is one entry), so 0 means nothing would be lost by
 * removing the worktree. Not the task's diff against base, which also counts
 * committed work. Null when git can't read the worktree (folder gone, not a
 * repo). Leftovers count here, because removing the worktree loses them too;
 * triage asks `uncommittedWorkCount`.
 */
export async function uncommittedCount(worktreePath: string): Promise<number | null> {
	try {
		const out = (await gitFor(worktreePath).raw(["status", "--porcelain"])).trim();
		return out === "" ? 0 : out.split("\n").length;
	} catch {
		return null;
	}
}

/** Folders an agent harness or tool keeps in a worktree (Ateam's older launches wrote `.codex/hooks.json`). */
const LEFTOVER_DIRS = new Set([".codex", ".claude", ".agents", ".factory", ".cursor", ".gemini"]);
const LEFTOVER_NAMES = new Set(["GEMINI.md"]);
/** Screenshots and scratch. */
const LEFTOVER_EXT = /\.(png|jpe?g|gif|webp|log|bak|tmp)$/i;
/** A config a bundler compiled and failed to delete: tsup's `x.bundled_<id>.mjs`, Vite's `x.timestamp-<ms>-<id>.mjs`. */
const BUNDLER_TEMP = /\.(bundled_\w+|timestamp-\d+(-\w+)?)\.[cm]?js$/;

/**
 * An untracked path an agent or tool left behind rather than the task's work.
 * Only ever asked of untracked paths: a tracked change is work whatever its name.
 * An untracked folder git lists as one entry (`screenshots/`) is work unless
 * it is a tool folder, since its contents go unread.
 */
function isLeftover(path: string): boolean {
	const parts = path.split("/").filter(Boolean);
	const name = parts.at(-1) ?? "";
	return (
		parts.some((p) => LEFTOVER_DIRS.has(p)) ||
		LEFTOVER_NAMES.has(name) ||
		LEFTOVER_EXT.test(name) ||
		BUNDLER_TEMP.test(name)
	);
}

/**
 * `uncommittedCount` less untracked leftovers (see isLeftover): the work that
 * only exists in the worktree, which is what makes a task read "uncommitted".
 * Null when git can't read the worktree.
 */
export async function uncommittedWorkCount(worktreePath: string): Promise<number | null> {
	let out: string;
	try {
		// -z leaves paths unquoted, so a screenshot's spaces don't hide its name.
		out = await gitFor(worktreePath).raw(["status", "--porcelain", "-z"]);
	} catch {
		return null;
	}
	const fields = out.split("\0");
	let n = 0;
	for (let i = 0; i < fields.length; i++) {
		const entry = fields[i];
		if (!entry) continue;
		const xy = entry.slice(0, 2);
		// A rename or copy names its source in the next field.
		if (/[RC]/.test(xy)) i++;
		if (xy === "??" && isLeftover(entry.slice(3))) continue;
		n++;
	}
	return n;
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
 *
 * Conflicts are read from the index, never inferred from a throw: simple-git
 * rejects only on a non-zero exit WITH stderr, and a conflicted `git merge`
 * exits 1 with everything on stdout, so it resolved as "clean" and the merge
 * queue went on to merge the PR over a worktree left mid-merge.
 */
export async function updateFromBase(
	input: UpdateFromBaseInput,
): Promise<UpdateResult> {
	const git = gitFor(input.worktreePath);
	await git.raw(["fetch", "origin", input.baseBranch]);
	let failure: unknown;
	try {
		if (input.strategy === "rebase") {
			await git.raw(["rebase", `origin/${input.baseBranch}`]);
		} else {
			await git.raw(["merge", "--no-edit", `origin/${input.baseBranch}`]);
		}
	} catch (err) {
		failure = err;
	}
	const conflicts = await listConflicts(input.worktreePath);
	if (conflicts.length > 0) return { status: "conflicts", conflicts };
	if (failure) throw failure;
	return { status: "clean", conflicts: [] };
}

async function listConflicts(worktreePath: string): Promise<string[]> {
	const git = gitFor(worktreePath);
	const out = await safeRaw(git, ["diff", "--name-only", "--diff-filter=U"]);
	return out
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
}
