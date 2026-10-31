// How the Lead chat's items are drawn as blocks, and how a stack of agent
// replies decides which one it shows.
//
// Tasks touched from the chat report every finished turn back into it
// (main/lead/follow.ts), so after a while away several replies land one after
// another. They fold into one card that shows one reply at a time, the newest
// first, so a new reply is seen the moment it lands. Going back to read an
// older one holds still while more arrive, and the card says one did.
//
// Pure + unit-tested (see lead-blocks.test.ts).
import type { LeadItem } from "../../shared/lead";

export type ToolItem = Extract<LeadItem, { kind: "tool" }>;
export type AgentItem = Extract<LeadItem, { kind: "agent" }>;
export type Block =
	| { kind: "item"; item: LeadItem }
	| { kind: "tools"; id: string; tools: ToolItem[] }
	| { kind: "agents"; id: string; replies: AgentItem[] };

/** Consecutive tool calls read as one step, so they fold into one row.
 *  Consecutive agent replies fold into one card. Anything else in between (the
 *  user's message, the Lead's, a page, a notice) starts a new block. A block's
 *  id is its first item's, which never changes as more join it. */
export function toBlocks(items: LeadItem[]): Block[] {
	const out: Block[] = [];
	for (const item of items) {
		const last = out[out.length - 1];
		if (item.kind === "tool") {
			if (last?.kind === "tools") last.tools.push(item);
			else out.push({ kind: "tools", id: item.id, tools: [item] });
		} else if (item.kind === "agent") {
			if (last?.kind === "agents") last.replies.push(item);
			else out.push({ kind: "agents", id: item.id, replies: [item] });
		} else out.push({ kind: "item", item });
	}
	return out;
}

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
