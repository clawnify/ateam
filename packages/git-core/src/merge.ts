import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitCoreError } from "./errors";
import { gitFor } from "./git-client";
import { push, trackingStatus } from "./sync";
import { parseWorktreeList } from "./worktree-list";

const pexec = promisify(execFile);

export type MergeStrategy = "merge" | "squash" | "rebase";
export type LocalMainStrategy = "direct-ref" | "ff-worktree" | "skipped";

export interface LocalMainResult {
	localMainUpdated: boolean;
	localMainStrategy: LocalMainStrategy;
	reason?: string;
}

export interface MergeViaPRInput {
	repoPath: string;
	worktreePath: string;
	branch: string;
	baseBranch: string;
	strategy: MergeStrategy;
	title?: string;
	body?: string;
	/** Delete the remote branch after merge. Default false. */
	deleteRemoteBranch?: boolean;
}

export interface MergeResult extends LocalMainResult {
	prNumber: number | null;
	prUrl: string | null;
}

async function gh(args: string[], cwd: string): Promise<string> {
	try {
		const { stdout } = await pexec("gh", args, {
			cwd,
			maxBuffer: 16 * 1024 * 1024,
		});
		return stdout;
	} catch (err) {
		const e = err as { stderr?: string; message?: string };
		throw new GitCoreError(
			"GH_FAILED",
			`gh ${args.join(" ")} failed: ${e.stderr || e.message || String(err)}`,
			err,
		);
	}
}

const CHECKED_OUT_RE =
	/checked out at|refusing to (?:fetch|update) into|is already checked out|is already used by worktree/i;

/**
 * Update the LOCAL default branch after a remote merge, WITHOUT disturbing any
 * worktree's checkout.
 *
 * Mechanism 1 — direct ref fast-forward, touches no working tree:
 *   `git fetch origin <base>:<base>`
 *   Git itself refuses (non-zero) if <base> is checked out in any worktree, so
 *   it can never desync a checkout from its working tree. Safe to attempt
 *   unconditionally; a "checked out" error just routes us to mechanism 2.
 *
 * Mechanism 2 — fast-forward the worktree that OWNS <base>:
 *   locate it via `worktree list --porcelain`, then `fetch` + `merge --ff-only`
 *   inside it. `--ff-only` aborts rather than clobber if local <base> diverged.
 *   Only the branch's own worktree is touched.
 */
export async function updateLocalMain(
	repoPath: string,
	baseBranch: string,
): Promise<LocalMainResult> {
	const git = gitFor(repoPath);

	// Mechanism 1: direct ref fast-forward.
	try {
		await git.raw(["fetch", "origin", `${baseBranch}:${baseBranch}`]);
		return { localMainUpdated: true, localMainStrategy: "direct-ref" };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (!CHECKED_OUT_RE.test(msg)) {
			return {
				localMainUpdated: false,
				localMainStrategy: "skipped",
				reason: msg.trim().slice(0, 200),
			};
		}
		// else: base is checked out somewhere → mechanism 2.
	}

	// Mechanism 2: fast-forward inside the owning worktree.
	const list = parseWorktreeList(
		await git.raw(["worktree", "list", "--porcelain"]),
	);
	const owner = list.find((w) => w.branch === baseBranch);
	if (!owner) {
		return {
			localMainUpdated: false,
			localMainStrategy: "skipped",
			reason: `no worktree owns "${baseBranch}"`,
		};
	}

	const ownerGit = gitFor(owner.path);
	await ownerGit.raw(["fetch", "origin", baseBranch]);
	try {
		await ownerGit.raw(["merge", "--ff-only", `origin/${baseBranch}`]);
		return { localMainUpdated: true, localMainStrategy: "ff-worktree" };
	} catch {
		// Local base diverged from origin — refuse to clobber.
		return {
			localMainUpdated: false,
			localMainStrategy: "skipped",
			reason: "diverged",
		};
	}
}

/**
 * Merge a task branch into base via a GitHub PR (Stage A, entirely remote-side
 * and therefore safe for every local worktree), then auto-update local base
 * (Stage B, via updateLocalMain).
 */
export async function mergeViaPR(input: MergeViaPRInput): Promise<MergeResult> {
	// Ensure the branch is pushed and up to date on the remote.
	const status = await trackingStatus(input.worktreePath);
	if (!status || status.ahead > 0) {
		await push({ worktreePath: input.worktreePath, branch: input.branch });
	}

	// Find an existing PR, or create one.
	let prNumber: number | null = null;
	let prUrl: string | null = null;
	let alreadyMerged = false;

	try {
		const out = await gh(
			["pr", "view", "--json", "number,state,url"],
			input.worktreePath,
		);
		const parsed = JSON.parse(out) as {
			number?: number;
			state?: string;
			url?: string;
		};
		prNumber = parsed.number ?? null;
		prUrl = parsed.url ?? null;
		alreadyMerged = parsed.state === "MERGED";
	} catch {
		const createArgs = [
			"pr",
			"create",
			"--base",
			input.baseBranch,
			"--head",
			input.branch,
		];
		if (input.title) {
			createArgs.push("--title", input.title, "--body", input.body ?? "");
		} else {
			createArgs.push("--fill");
		}
		await gh(createArgs, input.worktreePath);
		const viewOut = await gh(
			["pr", "view", "--json", "number,url"],
			input.worktreePath,
		);
		const p = JSON.parse(viewOut) as { number?: number; url?: string };
		prNumber = p.number ?? null;
		prUrl = p.url ?? null;
	}

	// Merge the PR remotely (no local checkout is touched).
	if (!alreadyMerged) {
		const mergeArgs = ["pr", "merge"];
		if (prNumber != null) mergeArgs.push(String(prNumber));
		mergeArgs.push(`--${input.strategy}`);
		mergeArgs.push(
			input.deleteRemoteBranch ? "--delete-branch" : "--delete-branch=false",
		);
		await gh(mergeArgs, input.worktreePath);
	}

	// Stage B: bring the merge back into the local base branch, safely.
	const local = await updateLocalMain(input.repoPath, input.baseBranch);

	return { prNumber, prUrl, ...local };
}
