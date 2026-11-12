// The dot on the header's Lead button, for while the chat is closed: amber when
// the Lead's own permission prompt holds its turn (it can't go on until it's
// answered), white when something arrived since the chat was last on screen: a
// reply from the Lead, a followed task's reply or page, a proposal, a notice.
// The user's own messages and tool rows never light it. The hook that keeps
// it for the Lead's box (picked in Boxes) is useLeadBadge.ts.
//
// "Seen" is the newest item's time (the box's clock, so the phone's clock can't
// skew it) when the chat was last on screen, kept per box across launches.
import type { LeadItem, TaskDTO } from "@ateam/protocol";

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

/** A task's question waits in the chat's "Waiting on you" tray, which is out of
 *  sight while the chat is closed: any open one turns the dot amber. */
export function withQuestions(badge: LeadBadge, tasks: Pick<TaskDTO, "question">[]): LeadBadge {
	return tasks.some((t) => t.question) ? "waiting" : badge;
}

/** The tasks whose question hasn't been announced yet, newest first, and the
 *  ids to remember: only the open ones, so the set never grows past the board. */
export function unannouncedQuestions<T extends Pick<TaskDTO, "question">>(
	tasks: T[],
	announced: ReadonlySet<string>,
): { fresh: T[]; open: Set<string> } {
	const open = new Set<string>();
	const fresh: T[] = [];
	for (const t of tasks) {
		if (!t.question) continue;
		open.add(t.question.id);
		if (!announced.has(t.question.id)) fresh.push(t);
	}
	fresh.sort((a, b) => (b.question?.askedAt ?? 0) - (a.question?.askedAt ?? 0));
	return { fresh, open };
}

/** The snackbar's words for questions that just arrived. */
export function questionSnack(fresh: Pick<TaskDTO, "name">[]): string | null {
	const first = fresh[0];
	if (!first) return null;
	return fresh.length === 1
		? `${first.name} is waiting on you`
		: `${fresh.length} tasks are waiting on you`;
}
