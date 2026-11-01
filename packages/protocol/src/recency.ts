// How recently a task last changed, for the board's cards and columns and for
// the Lead's get_board: one function, so the Lead never says "an hour ago" of a
// card that reads "2h". `lastEventAt` is the task's last state change from its
// agent's hooks (a turn starting or ending, a question, a reply), falling back
// to when it was created; background writes like the git sweep never move it.
// Imports nothing, so every client resolves it (desktop, phone, engine).

/**
 * Compact age label ("just now", "5m", "3h", "6d"). Deliberately short: on a
 * card it sits inline in the meta row next to the git counts.
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

/** Newest activity first; a task with none sorts last. */
export function byLatestActivity(
	a: { lastEventAt?: number | null },
	b: { lastEventAt?: number | null },
): number {
	return (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0);
}
