import { expect, test } from "bun:test";
import type { LeadItem } from "../../shared/lead";
import {
	arrived,
	FOLLOWING,
	firstLine,
	goTo,
	type StackView,
	shown,
	toBlocks,
	unseen,
} from "./lead-blocks";

const task = (name: string) => ({ taskId: name, name, agentId: "claude" });
const agent = (id: string, from = "fix login"): LeadItem => ({
	kind: "agent",
	id,
	task: task(from),
	text: `reply ${id}`,
	at: 1,
});
const tool = (id: string): LeadItem => ({ kind: "tool", id, name: "get_board", input: {}, at: 1 });
const user = (id: string): LeadItem => ({ kind: "user", id, text: "hi", at: 1 });
const page = (id: string): LeadItem => ({
	kind: "page",
	id,
	task: task("site"),
	pageId: "p",
	title: "t",
	at: 1,
});

const shape = (items: LeadItem[]) =>
	toBlocks(items).map((b) =>
		b.kind === "agents"
			? `agents:${b.id}:${b.replies.map((r) => r.id).join(",")}`
			: b.kind === "tools"
				? `tools:${b.id}:${b.tools.length}`
				: `${b.item.kind}:${b.item.id}`,
	);

test("replies one after another fold into one stack, whichever task sent them", () => {
	expect(shape([agent("a", "one"), agent("b", "two"), agent("c", "one")])).toEqual([
		"agents:a:a,b,c",
	]);
});

test("anything between replies starts a new stack", () => {
	expect(
		shape([agent("a"), user("u"), agent("b"), page("p"), agent("c"), tool("t"), agent("d")]),
	).toEqual([
		"agents:a:a",
		"user:u",
		"agents:b:b",
		"page:p",
		"agents:c:c",
		"tools:t:1",
		"agents:d:d",
	]);
});

test("tool calls still fold as before", () => {
	expect(shape([tool("t1"), tool("t2"), agent("a"), tool("t3")])).toEqual([
		"tools:t1:2",
		"agents:a:a",
		"tools:t3:1",
	]);
});

test("a stack keeps its first reply's id as more join it", () => {
	const before = toBlocks([user("u"), agent("a")]);
	const after = toBlocks([user("u"), agent("a"), agent("b")]);
	expect(before[1]?.kind === "agents" && before[1].id).toBe("a");
	expect(after[1]?.kind === "agents" && after[1].id).toBe("a");
});

test("a stack opens on the newest reply and follows new ones", () => {
	expect(shown(FOLLOWING, 3)).toBe(2);
	expect(shown(FOLLOWING, 4)).toBe(3);
	expect(unseen(FOLLOWING, 4)).toBe(false);
});

test("going back holds that reply while more arrive, and flags the new one", () => {
	let v: StackView = goTo(FOLLOWING, 0, 3);
	expect(v).toEqual({ at: 0, seen: 2 });
	expect(unseen(v, 3)).toBe(false);
	v = arrived(v, 3, 4, true);
	expect(shown(v, 4)).toBe(0);
	expect(unseen(v, 4)).toBe(true);
	// Stepping forward to the one already seen leaves the new one flagged.
	v = goTo(v, 2, 4);
	expect(unseen(v, 4)).toBe(true);
	// Reaching the newest follows again.
	v = goTo(v, 3, 4);
	expect(v.at).toBe(null);
	expect(unseen(v, 4)).toBe(false);
});

test("a reply arriving while the user reads further up doesn't replace the one shown", () => {
	const v = arrived(FOLLOWING, 2, 3, false);
	expect(shown(v, 3)).toBe(1);
	expect(unseen(v, 3)).toBe(true);
});

test("a reply arriving while the user is at the bottom is shown", () => {
	expect(arrived(FOLLOWING, 2, 3, true)).toBe(FOLLOWING);
});

test("going to a reply out of range lands on the nearest one", () => {
	expect(shown(goTo(FOLLOWING, -1, 3), 3)).toBe(0);
	expect(goTo(FOLLOWING, 9, 3).at).toBe(null);
});

test("the list shows a reply's first line without its markdown", () => {
	expect(firstLine("\n## Done\n\nmore")).toBe("Done");
	expect(firstLine("- **Before merging:** synced")).toBe("Before merging: synced");
	expect(firstLine("I merged it as PR #346 ([link](https://x.y/346)), commit `61a09b3`.")).toBe(
		"I merged it as PR #346 (link), commit 61a09b3.",
	);
	expect(firstLine("2 tasks failed")).toBe("2 tasks failed");
	expect(firstLine("1. First step")).toBe("First step");
	expect(firstLine("lead_chat is fine")).toBe("lead_chat is fine");
});
