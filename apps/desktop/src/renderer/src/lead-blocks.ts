// How a stack of task threads in the Lead chat decides which one it shows
// (folding the items into blocks is shared with the phone: toLeadBlocks in
// @ateam/protocol).
//
// Tasks touched from the chat report every finished turn back into it
// (lead/follow.ts), so after a while away several tasks have talked one after
// another. Each task's replies, and the user's answers to it, are one thread;
// the threads fold into one card that shows one at a time, the task that spoke
// last first, so a new reply is seen the moment it lands. Going back to read
// an older one holds still while more arrive, and the card says one did.
//
// A thread is held by its task's id, not its place: a task that talks again
// moves to the end of the stack, where the newest is.
//
// Pure + unit-tested (see lead-blocks.test.ts).

/** Which thread of a stack is shown. `at` null follows the newest; `seen` is
 *  how many of the stack's entries had landed when the user last looked at
 *  the newest, kept while `at` holds an older one. */
export interface StackView {
	at: string | null;
	seen: number;
}

export const FOLLOWING: StackView = { at: null, seen: -1 };

/** The index shown, out of the stack's thread `keys`, newest last. */
export function shown(v: StackView, keys: string[]): number {
	const i = v.at === null ? -1 : keys.indexOf(v.at);
	return i < 0 ? keys.length - 1 : i;
}

/** The user steps to thread `i` of `keys`, with `total` entries landed. Landing
 *  on the newest follows new ones again. */
export function goTo(v: StackView, i: number, keys: string[], total: number): StackView {
	const to = Math.max(0, Math.min(i, keys.length - 1));
	if (to === keys.length - 1) return { at: null, seen: total };
	return { at: keys[to] ?? null, seen: v.at === null ? total : v.seen };
}

/** The stack had `before` entries with `beforeKeys` threads, and now has
 *  more. While the user follows the bottom of the chat, the newest is shown,
 *  as a new card would be. Scrolled up reading, the thread they are on stays
 *  put rather than vanishing under them. */
export function arrived(
	v: StackView,
	beforeKeys: string[],
	before: number,
	total: number,
	atBottom: boolean,
): StackView {
	const was = beforeKeys[beforeKeys.length - 1];
	if (v.at !== null || atBottom || total <= before || was === undefined) return v;
	return { at: was, seen: before };
}

/** Another task spoke after the one being read, and the user hasn't looked. A
 *  held thread that itself got the new entry is at the end and shows it. */
export function unseen(v: StackView, keys: string[], total: number): boolean {
	return v.at !== null && shown(v, keys) < keys.length - 1 && total > v.seen;
}

/** A reply's first line of text, for the stack's list and a folded reply:
 *  its markdown marks (headings, bullets, numbering, quotes, bold, code ticks,
 *  link targets) dropped. */
export function firstLine(text: string): string {
	const line = text.split("\n").find((l) => /\w/.test(l)) ?? "";
	return line
		.replace(/^\s*(?:(?:#{1,6}|>|[*+-]|\d+[.)])\s+)+/, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*`]/g, "")
		.trim();
}

/** Which of a thread's entries open in full: the last reply and what came
 *  after it (the user's answers, pages, notices). Before it, each folds to a
 *  line, unless the user opened it. With no reply in the card, all of it. */
export function openFrom(kinds: string[]): number {
	return Math.max(0, kinds.lastIndexOf("agent"));
}
