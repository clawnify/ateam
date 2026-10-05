/**
 * Keep every task's git + PR facts fresh, not just the one you're looking at.
 *
 * Until this existed, `gitStatus` and external-merge detection both hung off a
 * single RPC (`CH.gitStatus`), which the renderer fires from exactly one place:
 * the open task's panel. Every other row on the board and in the sidebar was
 * therefore showing a snapshot from whenever you last opened it — or nothing at
 * all, for a task you never opened in this install. That is fine for a diff
 * view (you're looking at it) and useless for a list (you're not).
 *
 * Two triggers, ONE path. `refresh()` is what the RPC calls and what the timer
 * calls, so they share the per-task throttle below and can never double-probe
 * the same worktree. Everything is best-effort: a failed probe leaves the last
 * known values in place and is retried on the next pass.
 */

import { type AteamDb, repo, type Task } from "@ateam/db";
import { detectMerged, diff, trackingStatus } from "@ateam/git-core";
import type { GitStatusSnapshot, PrState } from "@ateam/protocol";

/** How often the background pass runs. */
export const SWEEP_MS = 90_000;
/**
 * Floor between two probes of the SAME task, whichever trigger asks. Opening a
 * task panel re-renders often; without this, every render would shell out.
 */
export const PROBE_THROTTLE_MS = 60_000;
/** Worktrees probed per pass. Each costs git calls plus at most one `gh`. */
export const SWEEP_BATCH = 12;

export async function computeGitStatus(
	worktreePath: string,
	baseBranch: string,
): Promise<GitStatusSnapshot> {
	const tracking = await trackingStatus(worktreePath);
	const d = await diff({ worktreePath, baseBranch });
	return {
		ahead: tracking?.ahead ?? 0,
		behind: tracking?.behind ?? 0,
		dirty: d.files.length,
		updatedAt: Date.now(),
	};
}

/** git-core speaks GitHub's uppercase; the DB column is lowercase. */
function toPrState(s: "OPEN" | "MERGED" | "CLOSED" | null): PrState | null {
	if (s === "OPEN") return "open";
	if (s === "MERGED") return "merged";
	if (s === "CLOSED") return "closed";
	return null;
}

export interface WorktreeSweep {
	/**
	 * Probe one task now and persist what changed. Returns the fresh git
	 * snapshot, or the stored one when the throttle skipped the probe (so the
	 * RPC always has something to answer with).
	 */
	refresh(taskId: string): Promise<GitStatusSnapshot | null>;
	start(): void;
	stop(): void;
}

export interface SweepDeps {
	db: AteamDb;
	onTaskUpdated: (taskId: string) => void;
	/** True while a PTY is live for this task. Live tasks are refreshed by
	 *  their own events, so the background pass skips them. */
	isLive: (taskId: string) => boolean;
	sweepMs?: number;
}

export function createWorktreeSweep(deps: SweepDeps): WorktreeSweep {
	const { db, onTaskUpdated, isLive } = deps;
	const probedAt = new Map<string, number>();
	let timer: ReturnType<typeof setInterval> | null = null;
	/** Round-robin cursor, so a project with more tasks than SWEEP_BATCH still
	 *  gets every one of them refreshed, just over several passes. */
	let cursor = 0;

	/**
	 * Persist the PR facts we just learned. Deliberately split from the column
	 * move below: recording that a PR is open costs nothing and is always safe,
	 * whereas moving a task to Done is consequential and keeps its old guards.
	 */
	function applyPrFacts(task: Task, res: Awaited<ReturnType<typeof detectMerged>>): boolean {
		const state = toPrState(res.state);
		const patch: Parameters<typeof repo.updateTask>[2] = {};
		let changed = false;
		if (state !== null && state !== task.prState) {
			patch.prState = state;
			changed = true;
		}
		// Never clear a known PR: `gh` being unavailable must not look like the
		// PR was withdrawn.
		if (res.prNumber != null && res.prNumber !== task.prNumber) {
			patch.prNumber = res.prNumber;
			changed = true;
		}
		if (res.prUrl != null && res.prUrl !== task.prUrl) {
			patch.prUrl = res.prUrl;
			changed = true;
		}
		// A merge found outside Ateam moves the card to Done — but only under the
		// same conditions the old inline check used: the conversation wrapped up
		// (agent idle/stopped, not parked on a question) and nothing is flagged
		// for the user. Otherwise the task keeps its column and just wears the
		// merged PR state.
		const finished =
			task.agentStatus == null || task.agentStatus === "idle" || task.agentStatus === "stopped";
		if (res.merged && finished && task.column !== "merged" && task.column !== "needs_attention") {
			patch.column = "merged";
			patch.prState = "merged";
			changed = true;
		}
		if (!changed) return false;
		repo.updateTask(db, task.id, patch);
		return true;
	}

	async function probe(task: Task): Promise<GitStatusSnapshot | null> {
		let changed = false;
		let snapshot: GitStatusSnapshot | null = null;
		try {
			snapshot = await computeGitStatus(task.worktreePath, task.baseBranch);
			repo.updateTask(db, task.id, { gitStatus: snapshot });
			changed = true;
		} catch {
			/* worktree gone or git unavailable — keep the last known snapshot */
		}
		// A merged task is terminal: no PR fact can change what it says.
		if (task.column !== "merged") {
			try {
				const res = await detectMerged({
					worktreePath: task.worktreePath,
					branch: task.branch,
					baseBranch: task.baseBranch,
				});
				// Re-read: computeGitStatus above already wrote, and the merge probe
				// is slow enough that the row may have moved under us.
				const fresh = repo.getTask(db, task.id);
				if (fresh && applyPrFacts(fresh, res)) changed = true;
			} catch {
				/* offline or gh unavailable — retried on a later pass */
			}
		}
		if (changed) onTaskUpdated(task.id);
		return snapshot;
	}

	async function refresh(taskId: string): Promise<GitStatusSnapshot | null> {
		const task = repo.getTask(db, taskId);
		if (!task) return null;
		if (Date.now() - (probedAt.get(taskId) ?? 0) < PROBE_THROTTLE_MS) {
			return task.gitStatus ?? null;
		}
		probedAt.set(taskId, Date.now());
		return probe(task);
	}

	/** One pass: the next few stale, not-live tasks across every project. */
	async function sweep(): Promise<void> {
		const all: Task[] = [];
		for (const project of repo.listProjects(db)) all.push(...repo.listTasks(db, project.id));
		if (all.length === 0) return;
		const now = Date.now();
		const due = all.filter(
			(t) => !isLive(t.id) && now - (probedAt.get(t.id) ?? 0) >= PROBE_THROTTLE_MS,
		);
		if (due.length === 0) return;
		if (cursor >= due.length) cursor = 0;
		const batch = due.slice(cursor, cursor + SWEEP_BATCH);
		cursor += batch.length;
		for (const task of batch) {
			probedAt.set(task.id, Date.now());
			await probe(task);
		}
	}

	let running = false;
	return {
		refresh,
		start() {
			timer ??= setInterval(() => {
				// Overlap guard: a slow pass (many worktrees, a hung `gh`) must not
				// stack passes on top of each other.
				if (running) return;
				running = true;
				void sweep().finally(() => {
					running = false;
				});
			}, deps.sweepMs ?? SWEEP_MS);
		},
		stop() {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
		},
	};
}
