import { describe, expect, it } from "bun:test";
import type { Task } from "@ateam/db";
import { signalsFromTask, triageTask } from "../src/task-triage";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
/** Older than triage's 2h "recent activity" window, so a card is not `active`. */
const STALE = NOW - 5 * HOUR;

function task(over: Partial<Task> = {}): Task {
	return {
		id: "t1",
		projectId: "p1",
		name: "a task",
		description: null,
		slug: "a-task",
		branch: "a-task",
		baseBranch: "main",
		worktreePath: "/wt/a-task",
		column: "todo",
		agentStatus: null,
		agentId: null,
		prNumber: null,
		prUrl: null,
		prState: null,
		mergeStatus: null,
		gitStatus: null,
		lastEventAt: STALE,
		isUnread: false,
		createdBy: "ateam",
		createdAt: STALE,
		updatedAt: STALE,
		...over,
	} as Task;
}

const git = (
	over: Partial<{ ahead: number; behind: number; dirty: number; updatedAt: number }>,
) => ({
	ahead: 0,
	behind: 0,
	dirty: 0,
	updatedAt: STALE,
	...over,
});

describe("triageTask", () => {
	it("calls a task with a live, advancing agent active, never done", () => {
		const r = triageTask(task({ agentStatus: "running", lastEventAt: NOW - 30_000 }), NOW);
		expect(r.bucket).toBe("active");
		expect(r.done).toBe(false);
	});

	it("treats an agent waiting on the user as live too", () => {
		expect(triageTask(task({ agentStatus: "awaiting_input" }), NOW).bucket).toBe("active");
	});

	it("calls a recently touched task active even with no agent", () => {
		expect(triageTask(task({ lastEventAt: NOW - 60_000 }), NOW).bucket).toBe("active");
	});

	it("flags uncommitted work as ongoing", () => {
		const r = triageTask(task({ gitStatus: git({ dirty: 3 }) }), NOW);
		expect(r.bucket).toBe("uncommitted");
		expect(r.done).toBe(false);
		expect(r.reason).toContain("3 uncommitted");
	});

	it("flags an open PR as ongoing", () => {
		const r = triageTask(task({ prState: "open", prNumber: 12 }), NOW);
		expect(r.bucket).toBe("open_pr");
		expect(r.done).toBe(false);
	});

	it("flags commits ahead with no merge as unmerged work", () => {
		const r = triageTask(task({ gitStatus: git({ ahead: 2 }) }), NOW);
		expect(r.bucket).toBe("unmerged_no_pr");
		expect(r.reason).toContain("2 commit(s) ahead");
	});

	it("calls a merged PR done", () => {
		const r = triageTask(task({ prState: "merged", prNumber: 12 }), NOW);
		expect(r.bucket).toBe("merged_done");
		expect(r.done).toBe(true);
	});

	// The bug the PTY cannot see: `exec $SHELL` keeps the terminal alive after the
	// agent dies, so liveness alone says "healthy" forever.
	it("calls a running agent that stopped advancing stalled", () => {
		const r = triageTask(task({ agentStatus: "running", lastEventAt: NOW - 3 * HOUR }), NOW);
		expect(r.bucket).toBe("stalled");
		expect(r.done).toBe(false);
		expect(r.reason).toContain("may need restart");
	});

	it("does not call an agent parked on a question stalled — it is waiting on the user", () => {
		const r = triageTask(
			task({ agentStatus: "awaiting_input", lastEventAt: NOW - 13 * HOUR }),
			NOW,
		);
		expect(r.bucket).toBe("active");
	});

	it("leaves a running agent that is still advancing alone", () => {
		const r = triageTask(task({ agentStatus: "running", lastEventAt: NOW - 60_000 }), NOW);
		expect(r.bucket).toBe("active");
	});

	// A stale card whose panel was merely OPENED refreshes gitStatus.updatedAt.
	// If the stall check used lastActivityMs (which folds that in), looking at a
	// wedged card would hide that it is wedged.
	it("stays stalled even when gitStatus was just refreshed by opening the panel", () => {
		const r = triageTask(
			task({
				agentStatus: "running",
				lastEventAt: NOW - 5 * HOUR,
				gitStatus: git({ updatedAt: NOW - 1000 }),
			}),
			NOW,
		);
		expect(r.bucket).toBe("stalled");
	});

	it("flags a running card that never emitted a single hook event", () => {
		const r = triageTask(
			task({ agentStatus: "running", lastEventAt: null, createdAt: NOW - 4 * HOUR }),
			NOW,
		);
		expect(r.bucket).toBe("stalled");
	});

	it("does not call an untouched card done", () => {
		const r = triageTask(task(), NOW);
		expect(r.bucket).toBe("not_started");
		expect(r.done).toBe(false);
	});
});

describe("signalsFromTask", () => {
	// The db stores PrState lowercase; WorktreeSignals speaks gh's uppercase. A
	// silent mismatch here would make every PR look like "no PR".
	it("maps the db's lowercase PR state to gh's casing", () => {
		expect(signalsFromTask(task({ prState: "open" })).prState).toBe("OPEN");
		expect(signalsFromTask(task({ prState: "merged" })).prState).toBe("MERGED");
		expect(signalsFromTask(task({ prState: "closed" })).prState).toBe("CLOSED");
		expect(signalsFromTask(task({ prState: null })).prState).toBeNull();
	});

	it("reads counts off the git snapshot and survives a missing one", () => {
		const s = signalsFromTask(task({ gitStatus: git({ ahead: 4, dirty: 7 }) }));
		expect(s.commitsAhead).toBe(4);
		expect(s.dirtyRealCount).toBe(7);

		const none = signalsFromTask(task({ gitStatus: null }));
		expect(none.commitsAhead).toBe(0);
		expect(none.dirtyRealCount).toBe(0);
	});
});
