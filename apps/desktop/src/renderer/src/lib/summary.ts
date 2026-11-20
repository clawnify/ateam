/**
 * "Written at 19:02, before the latest turn", naming the day when it isn't
 * today: what the task header and its peek say before a summary the task has
 * moved past (staleSummaryAt in @ateam/protocol).
 */
export function staleSummaryNote(asOf: number, now = Date.now()): string {
	const at = new Date(asOf);
	const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	const day =
		at.toDateString() === new Date(now).toDateString()
			? ""
			: `${at.toLocaleDateString([], { month: "short", day: "numeric" })} `;
	return `Written ${day}at ${time}, before the latest turn`;
}
