import { expect, test } from "bun:test";
import type { TaskDTO, TriageBucket } from "@ateam/protocol";
import { byWhatsNext, nextRank, relativeAge } from "./triage-order";

const NOW = 1_700_000_000_000;

function task(
	id: string,
	over: Partial<TaskDTO> = {},
	bucket: TriageBucket = "not_started",
): TaskDTO {
	return {
		id,
		projectId: "p1",
		name: id,
		description: null,
		slug: id,
		branch: id,
		baseBranch: "main",
		worktreePath: `/wt/${id}`,
		column: "todo",
		agentStatus: null,
		agentId: null,
		mergeStatus: null,
		prNumber: null,
		prUrl: null,
		gitStatus: null,
		lastEventAt: NOW,
		isUnread: false,
		triage: { bucket, done: false, reason: "test" },
		...over,
	};
}

test("an agent blocked on you outranks everything, including an open PR", () => {
	const blocked = task("blocked", { agentStatus: "awaiting_input" }, "active");
	const pr = task("pr", {}, "open_pr");
	expect(nextRank(blocked)).toBeLessThan(nextRank(pr));
});

test("a card in needs_attention counts as blocked even with no agent status", () => {
	expect(nextRank(task("x", { column: "needs_attention" }))).toBe(0);
});

test("news you have not seen outranks any triage bucket", () => {
	const unread = task("unread", { isUnread: true }, "merged_done");
	const pr = task("pr", {}, "open_pr");
	expect(nextRank(unread)).toBeLessThan(nextRank(pr));
});

test("a running agent sinks below work that wants a human", () => {
	const running = task("running", { agentStatus: "running" }, "active");
	expect(nextRank(task("pr", {}, "open_pr"))).toBeLessThan(nextRank(running));
	expect(nextRank(task("dirty", {}, "uncommitted"))).toBeLessThan(nextRank(running));
});

test("finished work sorts last", () => {
	const done = task("done", {}, "merged_done");
	for (const b of ["open_pr", "uncommitted", "unmerged_no_pr", "active"] as TriageBucket[]) {
		expect(nextRank(task("x", {}, b))).toBeLessThan(nextRank(done));
	}
});

test("within a band the longest-ignored card surfaces first", () => {
	const fresh = task("fresh", { lastEventAt: NOW }, "open_pr");
	const stale = task("stale", { lastEventAt: NOW - 5 * 86_400_000 }, "open_pr");
	expect([fresh, stale].sort(byWhatsNext).map((t) => t.id)).toEqual(["stale", "fresh"]);
});

test("full ordering: blocked, then unread, then urgency, then age", () => {
	const list = [
		task("done", {}, "merged_done"),
		task("openPr", {}, "open_pr"),
		task("blocked", { agentStatus: "awaiting_input" }, "active"),
		task("unread", { isUnread: true }, "not_started"),
	];
	expect(list.sort(byWhatsNext).map((t) => t.id)).toEqual(["blocked", "unread", "openPr", "done"]);
});

test("a stalled agent rides in the top band — only a restart from you revives it", () => {
	const stalled = task("stalled", { agentStatus: "running" }, "stalled");
	expect(nextRank(stalled)).toBe(0);
	expect(nextRank(stalled)).toBeLessThan(nextRank(task("unread", { isUnread: true })));
	expect(nextRank(stalled)).toBeLessThan(nextRank(task("pr", {}, "open_pr")));
});

test("a healthy running agent still sinks below a stalled one", () => {
	const running = task("running", { agentStatus: "running" }, "active");
	const stalled = task("stalled", { agentStatus: "running" }, "stalled");
	expect([running, stalled].sort(byWhatsNext).map((t) => t.id)).toEqual(["stalled", "running"]);
});

test("relativeAge is compact and handles a missing timestamp", () => {
	expect(relativeAge(null, NOW)).toBeNull();
	expect(relativeAge(NOW - 5_000, NOW)).toBe("just now");
	expect(relativeAge(NOW - 5 * 60_000, NOW)).toBe("5m");
	expect(relativeAge(NOW - 3 * 3_600_000, NOW)).toBe("3h");
	expect(relativeAge(NOW - 6 * 86_400_000, NOW)).toBe("6d");
});
