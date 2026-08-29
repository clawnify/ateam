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
	merged_done: 8, // finished
};

/**
 * Blocked waiting on the user — the agent literally cannot continue. A stalled
 * agent belongs here too: it is dead work masquerading as running, and only a
 * restart from you revives it.
 */
function isBlockedOnYou(t: TaskDTO): boolean {
	return (
		t.agentStatus === "awaiting_input" ||
		t.column === "needs_attention" ||
		t.triage.bucket === "stalled"
	);
}

/** Priority band for one task. Lower sorts first. */
export function nextRank(t: TaskDTO): number {
	if (isBlockedOnYou(t)) return 0;
	if (t.isUnread) return 100;
	return 200 + BUCKET_RANK[t.triage.bucket];
}

/**
 * Comparator for the "what's next" order: band first, then oldest activity
 * first, so the thing you have been ignoring longest surfaces within its band.
 */
export function byWhatsNext(a: TaskDTO, b: TaskDTO): number {
	const d = nextRank(a) - nextRank(b);
	if (d !== 0) return d;
	return (a.lastEventAt ?? 0) - (b.lastEventAt ?? 0);
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
