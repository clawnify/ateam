/**
 * Worktree triage — "is this task actually done, or still ongoing?"
 *
 * The board reconciler mislabels tasks as done because it judges from one thin
 * signal (a merged PR). This module encodes the richer done-vs-ongoing logic
 * from the user's `triage-worktrees` / `cleanup-worktrees` skills
 * (pallaoro/dotfiles) so the board organizer stops calling work finished when it
 * isn't. It is the "context" the deterministic reconciler was missing, made
 * explicit and testable.
 *
 * The rules that matter (each one is a way the naive "PR merged → done" check
 * gets it wrong):
 *   • RECENT ACTIVITY = in-flight. Any activity within `recentHours` (freshest
 *     of index / transcript / creation mtime) means a session may still hold it
 *     — never done, whatever git says.
 *   • MERGED ≠ DONE if the conversation continued. A transcript touched ≥ 4 min
 *     after the PR merged means follow-up work — still ongoing.
 *   • DIRTY / AHEAD / OPEN-PR = ongoing.
 *   • PATCH-EQUIVALENCE. "commits ahead" lies about squash/rebase/cherry-pick
 *     merges; a caller that ran `git cherry` sets `patchEquivalent` to mean
 *     "already in main".
 *   • NO WORK ≠ DONE. A fresh card with no commits, no PR, clean tree hasn't
 *     started — it is not finished.
 *
 * Pure module: callers gather the signals (git / gh / stat / transcript mtime);
 * this only classifies. No db, no I/O; `now` is injected. Unit-tested in
 * apps/desktop/test/worktree-triage.test.ts.
 */

/** Activity within this window means a live session may still own the tree. */
export const DEFAULT_RECENT_HOURS = 2;
/** A transcript touched this long after mergedAt means the talk continued. */
export const CONVERSATION_GAP_MS = 4 * 60 * 1000;

/** Signals a caller gathers per worktree. All times are epoch ms. */
export interface WorktreeSignals {
	/** Live agent process attached (pid alive)? Overrides everything → active. */
	agentAlive?: boolean;
	/** Worktree creation time. */
	createdAtMs?: number | null;
	/** `.git/worktrees/<n>/index` mtime — moves on git ops/commits. */
	indexMtimeMs?: number | null;
	/** Newest session-transcript mtime — moves on conversation activity. */
	transcriptMtimeMs?: number | null;
	/** Count of REAL dirty files (caller has already excluded node_modules/dist/junk). */
	dirtyRealCount: number;
	/** Commits ahead of the base branch. */
	commitsAhead: number;
	/** Every ahead-commit is patch-equivalent to one already in main (git cherry `-`). */
	patchEquivalent?: boolean;
	/** PR state for this branch, if any. */
	prState?: "OPEN" | "MERGED" | "CLOSED" | null;
	/** When the PR merged (epoch ms), if MERGED. */
	mergedAtMs?: number | null;
	/** On disk but not in `git worktree list` (broken/foreign git link). */
	isOrphan?: boolean;
}

/** Buckets, ordered by urgency — the first that matches wins (as in the skill). */
export type WorktreeBucket =
	| "active" // recent activity or live agent — in-flight, do not touch
	| "uncommitted" // real dirty files
	| "open_pr" // PR is OPEN
	| "unmerged_no_pr" // commits ahead, not merged, not patch-equivalent
	| "merged_unfinished" // MERGED but the conversation continued past the merge
	| "merged_done" // MERGED (or patch-equivalent) and the session wrapped up
	| "orphan" // on disk but not a tracked worktree
	| "not_started"; // no work yet — NOT done, just untouched

/** Board column this bucket maps to, or null to leave the card where it is. */
export type SuggestedColumn = "todo" | "needs_attention" | "review" | "merged" | null;

export interface TriageResult {
	bucket: WorktreeBucket;
	/** The single question that started this: is the task actually finished? */
	done: boolean;
	/** Where the organizer should file it (null = leave as-is / in-flight). */
	suggestedColumn: SuggestedColumn;
	reason: string;
}

/** Freshest activity signal across creation / index / transcript. */
export function lastActivityMs(s: WorktreeSignals): number {
	return Math.max(s.createdAtMs ?? 0, s.indexMtimeMs ?? 0, s.transcriptMtimeMs ?? 0);
}

export interface TriageOptions {
	now: number;
	recentHours?: number;
}

/**
 * Classify one worktree. Checks run in urgency order so the first matching
 * bucket wins — and, crucially, every "ongoing" signal is checked BEFORE any
 * path that could return done, so the classifier errs toward "not done" exactly
 * where the reconciler errs toward "done".
 */
export function triageWorktree(s: WorktreeSignals, opts: TriageOptions): TriageResult {
	const recentHours = opts.recentHours ?? DEFAULT_RECENT_HOURS;

	// 1. Live agent or recent activity → in-flight. Never done.
	if (s.agentAlive) {
		return { bucket: "active", done: false, suggestedColumn: null, reason: "live agent attached" };
	}
	const idleMs = opts.now - lastActivityMs(s);
	if (idleMs < recentHours * 3600_000) {
		return {
			bucket: "active",
			done: false,
			suggestedColumn: null,
			reason: `activity within ${recentHours}h — in-flight`,
		};
	}

	// 2. Real uncommitted work → ongoing.
	if (s.dirtyRealCount > 0) {
		return {
			bucket: "uncommitted",
			done: false,
			suggestedColumn: "needs_attention",
			reason: `${s.dirtyRealCount} uncommitted file(s)`,
		};
	}

	// 3. Open PR → ongoing (needs review/merge).
	if (s.prState === "OPEN") {
		return { bucket: "open_pr", done: false, suggestedColumn: "review", reason: "PR is open" };
	}

	const merged = s.prState === "MERGED" || (s.patchEquivalent ?? false);

	// 4. Commits ahead, not merged/patch-equivalent → unmerged work.
	if (!merged && s.commitsAhead > 0) {
		return {
			bucket: "unmerged_no_pr",
			done: false,
			suggestedColumn: "review",
			reason: `${s.commitsAhead} commit(s) ahead, no merge`,
		};
	}

	// 5. Merged: done ONLY if the conversation wrapped up with the merge.
	if (merged) {
		const gap =
			s.transcriptMtimeMs != null && s.mergedAtMs != null ? s.transcriptMtimeMs - s.mergedAtMs : 0;
		if (gap >= CONVERSATION_GAP_MS) {
			return {
				bucket: "merged_unfinished",
				done: false,
				suggestedColumn: "review",
				reason: `merged, but conversation continued ${Math.round(gap / 60000)}m past merge`,
			};
		}
		return {
			bucket: "merged_done",
			done: true,
			suggestedColumn: "merged",
			reason: s.prState === "MERGED" ? "PR merged, session wrapped up" : "patch-equivalent to main",
		};
	}

	// 6. On disk but untracked → needs a human.
	if (s.isOrphan) {
		return {
			bucket: "orphan",
			done: false,
			suggestedColumn: "needs_attention",
			reason: "orphaned worktree dir",
		};
	}

	// 7. No commits, no PR, clean, quiet → hasn't started. NOT done.
	return {
		bucket: "not_started",
		done: false,
		suggestedColumn: null,
		reason: "no work yet — not started",
	};
}
