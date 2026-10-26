// "What's next" ordering for the task list.
//
// The board's columns say where work sits and the triage verdict says whether
// it is really finished, but neither alone answers the question you actually
// have after a day away: what do I pick up first? This layers the two.
//
// Triage on its own gets one case badly wrong: an agent blocked on a question
// is `active` (a live agent is never "done"), yet it is the single most urgent
// card on the board. So blocked-on-you wins outright, then anything that
// happened while you were away, then the triage buckets in the order a human
// cares about, and finally oldest-first so stale work rises instead of sinking.
//
// A task parked on an outside party (a wait — see waits.ts in the server) is
// layered on top the same way `isUnread` is, not as a bucket: an older client
// reading a newer engine would rank an unknown bucket as NaN, while a nullable
// field it never heard of is simply ignored. Live, the wait sinks the card to
// just above finished work; due, it is blocked on you.
//
// Pure + unit-tested (see triage-order.test.ts).
import type { TaskDTO, TriageBucket } from "@ateam/protocol";

/** How much each triage bucket wants a human, lower first. */
const BUCKET_RANK: Record<TriageBucket, number> = {
	stalled: 0, // an agent that stopped advancing; only you can restart it
	open_pr: 1, // a PR sitting there waiting on you
	uncommitted: 2, // real work not yet saved
	unmerged_no_pr: 3, // commits with nowhere to go yet
	merged_unfinished: 4, // merged, but the conversation kept going
	orphan: 5, // a worktree git no longer tracks
	not_started: 6, // hasn't begun — backlog, not urgency
	active: 7, // an agent has it; nothing for you to do
	merged_done: 9, // finished
};
/** A live wait sits between "an agent has it" and "finished": nothing to do yet. */
const WAITING_RANK = 8;

/** Is the task parked, and has its date passed? */
export function waitState(t: Pick<TaskDTO, "waitingUntil">, now: number): "none" | "live" | "due" {
	if (t.waitingUntil == null) return "none";
	return t.waitingUntil > now ? "live" : "due";
}

/**
 * Blocked waiting on the user — the agent literally cannot continue. A stalled
 * agent belongs here too: it is dead work masquerading as running, and only a
 * restart from you revives it.
 */
function isBlockedOnYou(t: TaskDTO, now: number): boolean {
	return (
		t.agentStatus === "awaiting_input" ||
		t.column === "needs_attention" ||
		t.triage.bucket === "stalled" ||
		waitState(t, now) === "due"
	);
}

/** Priority band for one task. Lower sorts first. */
export function nextRank(t: TaskDTO, now = Date.now()): number {
	if (isBlockedOnYou(t, now)) return 0;
	if (t.isUnread) return 100;
	// A live wait sinks the card, unless an agent is working in it right now: a
	// pending reminder does not make the task you are in the middle of less live.
	if (waitState(t, now) === "live" && t.triage.bucket !== "active") return 200 + WAITING_RANK;
	return 200 + BUCKET_RANK[t.triage.bucket];
}

/**
 * Comparator for the "what's next" order: band first, then oldest activity
 * first, so the thing you have been ignoring longest surfaces within its band.
 */
export function byWhatsNext(a: TaskDTO, b: TaskDTO): number {
	const now = Date.now();
	const d = nextRank(a, now) - nextRank(b, now);
	if (d !== 0) return d;
	return (a.lastEventAt ?? 0) - (b.lastEventAt ?? 0);
}

/**
 * The card's one-line account of a wait, replacing the triage reason while it
 * is parked: what it waits for and how far off (or overdue) the date is.
 */
export function waitingLabel(
	t: Pick<TaskDTO, "waitingUntil" | "waitingReason">,
	now: number,
): string | null {
	if (t.waitingUntil == null) return null;
	const what = t.waitingReason ?? "an outside party";
	if (t.waitingUntil > now) return `waiting for ${what} · ${relativeAge(now, t.waitingUntil)}`;
	const ago = relativeAge(t.waitingUntil, now);
	return `check on ${what} · due ${ago === "just now" ? "now" : `${ago} ago`}`;
}

/**
 * Compact age label ("just now", "5m", "3h", "6d") for a card. Deliberately
 * short: it sits inline in the card's meta row next to the git counts.
 */
export function relativeAge(at: number | null, now: number): string | null {
	if (at == null) return null;
	const s = Math.max(0, Math.round((now - at) / 1000));
	if (s < 60) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.round(h / 24)}d`;
}
