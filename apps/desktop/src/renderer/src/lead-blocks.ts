// How a stack of agent replies in the Lead chat decides which one it shows
// (folding the items into blocks is shared with the phone: toLeadBlocks in
// @ateam/protocol).
//
// Tasks touched from the chat report every finished turn back into it
// (main/lead/follow.ts), so after a while away several replies land one after
// another. They fold into one card that shows one reply at a time, the newest
// first, so a new reply is seen the moment it lands. Going back to read an
// older one holds still while more arrive, and the card says one did.
//
// Pure + unit-tested (see lead-blocks.test.ts).
/** Which reply of a stack is shown. `at` null follows the newest; `seen` is the
 *  newest one looked at, kept while `at` holds an older one. */
export interface StackView {
	at: number | null;
	seen: number;
}

export const FOLLOWING: StackView = { at: null, seen: -1 };

/** The index shown, out of `n` replies. */
export const shown = (v: StackView, n: number): number => Math.min(v.at ?? n - 1, n - 1);

/** The user steps to reply `i`. Landing on the newest follows new ones again. */
export function goTo(v: StackView, i: number, n: number): StackView {
	const to = Math.max(0, Math.min(i, n - 1));
	const seen = Math.max(v.at === null ? n - 1 : v.seen, to);
	return { at: to === n - 1 ? null : to, seen };
}

/** The stack grew from `before` to `n` replies. While the user follows the
 *  bottom of the chat, the newest is shown, as a new card would be. Scrolled up
 *  reading, the reply they are on stays put rather than vanishing under them. */
export function arrived(v: StackView, before: number, n: number, atBottom: boolean): StackView {
	if (v.at !== null || atBottom || n <= before || before < 1) return v;
	return { at: before - 1, seen: before - 1 };
}

/** A reply came in after the one being read, and the user hasn't looked at it. */
export const unseen = (v: StackView, n: number): boolean => v.at !== null && n - 1 > v.seen;

/** A reply's first line of text, for the stack's list: its markdown marks
 *  (headings, bullets, numbering, quotes, bold, code ticks, link targets) dropped. */
export function firstLine(text: string): string {
	const line = text.split("\n").find((l) => /\w/.test(l)) ?? "";
	return line
		.replace(/^\s*(?:(?:#{1,6}|>|[*+-]|\d+[.)])\s+)+/, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*`]/g, "")
		.trim();
}
