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
	const list = parseWorktreeList(await git.raw(["worktree", "list", "--porcelain"]));
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

export interface DetectMergedResult {
	merged: boolean;
	prNumber: number | null;
	prUrl: string | null;
}

/**
 * Detect a merge that happened OUTSIDE Ateam — the agent ran `gh pr merge` in
 * its terminal, or the PR was merged on github.com. `gh pr view` is the
 * primary signal because squash/rebase merges rewrite the commits, so the
 * branch tip never becomes an ancestor of base; the ancestor check is the
 * fallback for plain merges (or repos without a PR/gh).
 */
export async function detectMerged(input: {
	worktreePath: string;
	branch: string;
	baseBranch: string;
}): Promise<DetectMergedResult> {
	const git = gitFor(input.worktreePath);
	let tip = "";
	try {
		tip = (await git.raw(["rev-parse", input.branch])).trim();
	} catch {
		return { merged: false, prNumber: null, prUrl: null };
	}

	try {
		const out = await gh(
			["pr", "view", input.branch, "--json", "number,state,url,headRefOid"],
			input.worktreePath,
		);
		const p = JSON.parse(out) as {
			number?: number;
			state?: string;
			url?: string;
			headRefOid?: string;
		};
		if (p.state === "MERGED") {
			// `gh pr view <branch>` returns the most recent PR for that head NAME —
			// which can be a stale, already-merged PR from an earlier branch that
			// happened to share the name. Only trust MERGED when GitHub's recorded
			// head commit is the branch's current tip.
			if (p.headRefOid && p.headRefOid === tip) {
				return {
					merged: true,
					prNumber: p.number ?? null,
					prUrl: p.url ?? null,
				};
			}
			// Stale PR — fall through to the local merge-commit check.
		} else if (p.state === "OPEN" || p.state === "CLOSED") {
			return {
				merged: false,
				prNumber: p.number ?? null,
				prUrl: p.url ?? null,
			};
		}
	} catch {
		/* gh missing or no PR for this branch — fall through */
	}

	// Fallback for plain (--no-ff) merges without a PR: the branch tip shows up
	// as a parent of a merge commit on origin/<base>. Mere containment is NOT
	// enough — a freshly created (or stale) branch with no commits of its own
	// is trivially contained in base and would read as a false "merged".
	try {
		await git.raw(["fetch", "origin", input.baseBranch]);
		const mergeParents = await git.raw([
			"log",
			`origin/${input.baseBranch}`,
			"--merges",
			"--format=%P",
			"-n",
			"200",
		]);
		const merged = mergeParents
			.split("\n")
			.some((line) => line.trim().split(/\s+/).slice(1).includes(tip));
		return { merged, prNumber: null, prUrl: null };
	} catch {
		return { merged: false, prNumber: null, prUrl: null };
	}
}

export interface PrStatus {
	/** No PR found for this branch. */
	state: "OPEN" | "MERGED" | "CLOSED" | "NONE";
	/** Rollup of the PR's required checks. */
	checks: "passing" | "failing" | "pending" | "none";
	/** GitHub's mergeability verdict, when known. */
	mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
	prNumber: number | null;
}

/**
 * Read a branch's PR state + CI rollup + mergeability in one `gh` call. Used by
 * loop templates (PR-CI watcher, auto-merge-when-green). Read-only; touches no
 * worktree. Returns state "NONE" when there is no PR or gh is unavailable.
 */
export async function prStatus(worktreePath: string): Promise<PrStatus> {
	const none: PrStatus = {
		state: "NONE",
		checks: "none",
		mergeable: "UNKNOWN",
		prNumber: null,
	};
	try {
		const out = await gh(
			["pr", "view", "--json", "number,state,mergeable,statusCheckRollup"],
			worktreePath,
		);
		const p = JSON.parse(out) as {
			number?: number;
			state?: string;
			mergeable?: string;
			statusCheckRollup?: { status?: string; conclusion?: string; state?: string }[];
		};
		const rollup = p.statusCheckRollup ?? [];
		let checks: PrStatus["checks"] = rollup.length === 0 ? "none" : "passing";
		for (const c of rollup) {
			// A check is a CheckRun (status/conclusion) or a StatusContext (state).
			const done = c.status ? c.status === "COMPLETED" : c.state != null;
			const ok =
				(c.conclusion ?? c.state ?? "").toUpperCase() === "SUCCESS" ||
				(c.conclusion ?? "").toUpperCase() === "NEUTRAL" ||
				(c.conclusion ?? "").toUpperCase() === "SKIPPED";
			if (!done) {
				checks = "pending";
			} else if (!ok) {
				checks = "failing";
				break;
			}
		}
		const state =
			p.state === "OPEN" || p.state === "MERGED" || p.state === "CLOSED" ? p.state : "NONE";
		const mergeable =
			p.mergeable === "MERGEABLE" || p.mergeable === "CONFLICTING" ? p.mergeable : "UNKNOWN";
		return { state, checks, mergeable, prNumber: p.number ?? null };
	} catch {
		return none;
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
		const out = await gh(["pr", "view", "--json", "number,state,url"], input.worktreePath);
		const parsed = JSON.parse(out) as {
			number?: number;
			state?: string;
			url?: string;
		};
		prNumber = parsed.number ?? null;
		prUrl = parsed.url ?? null;
		alreadyMerged = parsed.state === "MERGED";
	} catch {
		const createArgs = ["pr", "create", "--base", input.baseBranch, "--head", input.branch];
		if (input.title) {
			createArgs.push("--title", input.title, "--body", input.body ?? "");
		} else {
			createArgs.push("--fill");
		}
		await gh(createArgs, input.worktreePath);
		const viewOut = await gh(["pr", "view", "--json", "number,url"], input.worktreePath);
		const p = JSON.parse(viewOut) as { number?: number; url?: string };
		prNumber = p.number ?? null;
		prUrl = p.url ?? null;
	}

	// Merge the PR remotely (no local checkout is touched).
	if (!alreadyMerged) {
		const mergeArgs = ["pr", "merge"];
		if (prNumber != null) mergeArgs.push(String(prNumber));
		mergeArgs.push(`--${input.strategy}`);
		mergeArgs.push(input.deleteRemoteBranch ? "--delete-branch" : "--delete-branch=false");
		await gh(mergeArgs, input.worktreePath);
	}

	// Stage B: bring the merge back into the local base branch, safely.
	const local = await updateLocalMain(input.repoPath, input.baseBranch);

	return { prNumber, prUrl, ...local };
}
