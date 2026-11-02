// The dot on the header's Lead button, for while the chat is closed: amber when
// the Lead's own permission prompt holds its turn (it can't go on until it's
// answered), white when something arrived since the chat was last on screen: a
// reply from the Lead, a followed task's reply or page, a proposal, a notice.
// The user's own messages and tool rows never light it. The hook that keeps
// it for the connected box is useLeadBadge.ts.
//
// "Seen" is the newest item's time (the box's clock, so the phone's clock can't
// skew it) when the chat was last on screen, kept per box across launches.
import type { LeadItem } from "@ateam/protocol";

export type LeadBadge = "waiting" | "new" | null;

/** What the badge needs from the conversation: the newest item that counts,
 *  and the permission prompts still waiting on an answer. */
export interface LeadBadgeState {
	newest: number;
	waiting: string[];
}

export const EMPTY_BADGE: LeadBadgeState = { newest: 0, waiting: [] };

/** How many of the last items to read on connect: enough to hold a turn's
 *  reply and any prompt waiting in it. */
export const BADGE_TAIL = 20;

const counts = (item: LeadItem) => item.kind !== "user" && item.kind !== "tool";

/** Items as they arrive (an item event replaces by id: a prompt's answer
 *  arrives as the same item again, now with `answer`). */
export function foldBadge(s: LeadBadgeState, items: LeadItem[]): LeadBadgeState {
	let { newest, waiting } = s;
	for (const item of items) {
		if (counts(item) && item.at > newest) newest = item.at;
		if (item.kind !== "permission") continue;
		const open = !item.answer;
		const had = waiting.includes(item.id);
		if (open && !had) waiting = [...waiting, item.id];
		else if (!open && had) waiting = waiting.filter((id) => id !== item.id);
	}
	return newest === s.newest && waiting === s.waiting ? s : { newest, waiting };
}

export function badgeOf(s: LeadBadgeState, seen: number | null): LeadBadge {
	if (s.waiting.length) return "waiting";
	return seen !== null && s.newest > seen ? "new" : null;
}
