import { describe, expect, it } from "bun:test";
import {
	CONVERSATION_GAP_MS,
	triageWorktree,
	type WorktreeSignals,
} from "../src/main/loops/worktree-triage";

const NOW = 1_000_000_000_000;
const HOUR = 3_600_000;
// A baseline "quiet" tree: last activity well outside the recent window.
const quiet = (over: Partial<WorktreeSignals> = {}): WorktreeSignals => ({
	indexMtimeMs: NOW - 10 * HOUR,
	transcriptMtimeMs: NOW - 10 * HOUR,
	dirtyRealCount: 0,
	commitsAhead: 0,
	...over,
});

const triage = (s: WorktreeSignals) => triageWorktree(s, { now: NOW, recentHours: 2 });

describe("triageWorktree — the false-done cases the reconciler gets wrong", () => {
	it("recent activity is in-flight, never done — even if merged", () => {
		const r = triage(
			quiet({
				prState: "MERGED",
				mergedAtMs: NOW - 5 * HOUR,
				transcriptMtimeMs: NOW - 10 * 60_000,
			}),
		);
		expect(r.bucket).toBe("active");
		expect(r.done).toBe(false);
		expect(r.suggestedColumn).toBeNull();
	});

	it("live agent is active regardless of git state", () => {
		const r = triage(quiet({ agentAlive: true, prState: "MERGED", mergedAtMs: NOW - 5 * HOUR }));
		expect(r.bucket).toBe("active");
		expect(r.done).toBe(false);
	});

	it("merged but the conversation continued past merge is NOT done", () => {
		const r = triage(
			quiet({
				prState: "MERGED",
				mergedAtMs: NOW - 9 * HOUR,
				// transcript touched well after the merge, but outside the recent window
				transcriptMtimeMs: NOW - 9 * HOUR + CONVERSATION_GAP_MS + 60_000,
			}),
		);
		expect(r.bucket).toBe("merged_unfinished");
		expect(r.done).toBe(false);
		expect(r.suggestedColumn).toBe("review");
	});

	it("merged with the session wrapped up at merge IS done", () => {
		const r = triage(
			quiet({
				prState: "MERGED",
				mergedAtMs: NOW - 9 * HOUR,
				transcriptMtimeMs: NOW - 9 * HOUR + 60_000, // 1m gap < 4m
			}),
		);
		expect(r.bucket).toBe("merged_done");
		expect(r.done).toBe(true);
		expect(r.suggestedColumn).toBe("merged");
	});

	it("a fresh untouched card is NOT done (no work ≠ done)", () => {
		const r = triage(quiet());
		expect(r.bucket).toBe("not_started");
		expect(r.done).toBe(false);
		expect(r.suggestedColumn).toBeNull();
	});

	it("uncommitted real work is ongoing", () => {
		const r = triage(quiet({ dirtyRealCount: 3 }));
		expect(r.bucket).toBe("uncommitted");
		expect(r.done).toBe(false);
		expect(r.suggestedColumn).toBe("needs_attention");
	});

	it("open PR is ongoing", () => {
		const r = triage(quiet({ prState: "OPEN", commitsAhead: 2 }));
		expect(r.bucket).toBe("open_pr");
		expect(r.done).toBe(false);
		expect(r.suggestedColumn).toBe("review");
	});

	it("commits ahead without a merge is unmerged work", () => {
		const r = triage(quiet({ commitsAhead: 4 }));
		expect(r.bucket).toBe("unmerged_no_pr");
		expect(r.done).toBe(false);
	});

	it("patch-equivalent commits count as merged (squash/rebase truth)", () => {
		const r = triage(
			quiet({ commitsAhead: 4, patchEquivalent: true, transcriptMtimeMs: NOW - 10 * HOUR }),
		);
		expect(r.bucket).toBe("merged_done");
		expect(r.done).toBe(true);
	});

	it("orphan dir needs a human, not done", () => {
		const r = triage(quiet({ isOrphan: true }));
		expect(r.bucket).toBe("orphan");
		expect(r.done).toBe(false);
		expect(r.suggestedColumn).toBe("needs_attention");
	});

	it("dirty beats merged — ongoing signals are checked first", () => {
		const r = triage(quiet({ dirtyRealCount: 1, prState: "MERGED", mergedAtMs: NOW - 9 * HOUR }));
		expect(r.bucket).toBe("uncommitted");
		expect(r.done).toBe(false);
	});
});
