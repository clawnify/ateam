import { expect, test } from "bun:test";
import type { LeadItem } from "@ateam/protocol";
import { badgeOf, EMPTY_BADGE, foldBadge } from "./lead-badge";

const user = (at: number): LeadItem => ({ kind: "user", id: `u${at}`, text: "hi", at });
const reply = (at: number): LeadItem => ({ kind: "assistant", id: `a${at}`, text: "done", at });
const tool = (at: number): LeadItem => ({
	kind: "tool",
	id: `t${at}`,
	name: "get_board",
	input: {},
	at,
});
const ask = (id: string, at: number, answer?: "allow" | "cancelled"): LeadItem => ({
	kind: "permission",
	id,
	text: "Run `npm test`",
	canAlways: false,
	always: null,
	at,
	...(answer ? { answer } : {}),
});

test("a reply after the chat was last on screen is new; the user's own words and tool rows are not", () => {
	const s = foldBadge(EMPTY_BADGE, [user(10), tool(11), reply(12)]);
	expect(badgeOf(s, 11)).toBe("new");
	expect(badgeOf(s, 12)).toBe(null);
	expect(badgeOf(foldBadge(EMPTY_BADGE, [user(20), tool(21)]), 12)).toBe(null);
});

test("a followed task's reply lights it too", () => {
	const s = foldBadge(EMPTY_BADGE, [
		{
			kind: "agent",
			id: "g1",
			task: { taskId: "t", name: "fix login", agentId: "claude" },
			text: "Done",
			at: 30,
		},
	]);
	expect(badgeOf(s, 20)).toBe("new");
});

test("a prompt holding the Lead's turn wins over new, until its answer arrives as the same item", () => {
	let s = foldBadge(EMPTY_BADGE, [reply(5), ask("p1", 6)]);
	// Even when seen: the Lead still can't go on.
	expect(badgeOf(s, 100)).toBe("waiting");
	s = foldBadge(s, [ask("p1", 6, "allow")]);
	expect(s.waiting).toEqual([]);
	expect(badgeOf(s, 100)).toBe(null);
	// A prompt that went away with the turn no longer waits either.
	s = foldBadge(s, [ask("p2", 7), ask("p2", 7, "cancelled")]);
	expect(badgeOf(s, 100)).toBe(null);
});

test("nothing shows before the phone knows what was seen", () => {
	expect(badgeOf(foldBadge(EMPTY_BADGE, [reply(9)]), null)).toBe(null);
});

test("an item event that changes nothing keeps the same state, so nothing re-renders", () => {
	const s = foldBadge(EMPTY_BADGE, [reply(9)]);
	expect(foldBadge(s, [tool(3)])).toBe(s);
});
