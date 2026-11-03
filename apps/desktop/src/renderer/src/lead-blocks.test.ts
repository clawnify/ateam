import { expect, test } from "bun:test";
import { type LeadBlock, type LeadItem, toLeadBlocks } from "@ateam/protocol";
import {
	arrived,
	FOLLOWING,
	firstLine,
	goTo,
	landed,
	openFrom,
	type StackView,
	shown,
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
/** The user's message: to the Lead, or with `to` to a task's agent. */
const user = (id: string, to?: string): LeadItem => ({
	kind: "user",
	id,
	text: "hi",
	at: 1,
	...(to ? { to: task(to) } : {}),
});
const lead = (id: string): LeadItem => ({ kind: "assistant", id, text: "ok", at: 1 });
const page = (id: string, from = "site"): LeadItem => ({
	kind: "page",
	id,
	task: task(from),
	pageId: "p",
	title: "t",
	at: 1,
});
const notice = (id: string, about?: string): LeadItem => ({
	kind: "notice",
	id,
	text: "n",
	tone: "info",
	at: 1,
	...(about ? { task: task(about) } : {}),
});

/** A block as text: a stack lists its threads, oldest talker first, each as
 *  task=entry ids. */
const shape = (items: LeadItem[]) =>
	toLeadBlocks(items).map((b) =>
		b.kind === "threads"
			? `threads:${b.id}:${b.threads.map((t) => `${t.key}=${t.entries.map((e) => e.id).join(",")}`).join(" ")}`
			: b.kind === "tools"
				? `tools:${b.id}:${b.tools.length}`
				: `${b.item.kind}:${b.item.id}`,
	);
const stacks = (items: LeadItem[]) =>
	toLeadBlocks(items).filter(
		(b): b is Extract<LeadBlock, { kind: "threads" }> => b.kind === "threads",
	);

test("one task's replies in a row are one thread, not a stack to page", () => {
	expect(shape([agent("a"), agent("b"), agent("c")])).toEqual(["threads:a:fix login=a,b,c"]);
});

test("tasks talking one after another fold into one stack, a thread per task, the last talker last", () => {
	expect(shape([agent("a", "one"), agent("b", "two"), agent("c", "one")])).toEqual([
		"threads:a:two=b one=a,c",
	]);
});

test("the user's answers to a task, its pages and its notices go in its thread", () => {
	expect(
		shape([
			agent("a"),
			user("u", "fix login"),
			agent("b"),
			page("p", "fix login"),
			notice("n", "fix login"),
		]),
	).toEqual(["threads:a:fix login=a,u,b,p,n"]);
	// Every entry, in the order it came, for a client that draws them one by one.
	expect(
		stacks([agent("a", "one"), agent("b", "two"), user("u", "one")])[0]?.items.map((e) => e.id),
	).toEqual(["a", "b", "u"]);
});

test("the user's answer stays in its thread where it stands: only a task talking moves one", () => {
	expect(shape([agent("a", "one"), agent("b", "two"), user("u", "one")])).toEqual([
		"threads:a:one=a,u two=b",
	]);
	// The task answering back is what brings it to the end.
	expect(
		shape([agent("a", "one"), agent("b", "two"), user("u", "one"), agent("c", "one")]),
	).toEqual(["threads:a:two=b one=a,u,c"]);
});

test("words to a task with no thread in the stack open no page, and its next one opens with them", () => {
	// An answer to a question: the task has said nothing in this stack.
	expect(shape([agent("a", "one"), user("q", "two")])).toEqual(["threads:a:one=a"]);
	expect(shape([agent("a", "one"), user("q", "two"), user("r", "two"), agent("b", "two")])).toEqual(
		["threads:a:one=a two=q,r,b"],
	);
	// Still every entry for a client that draws them one by one.
	expect(stacks([agent("a", "one"), user("q", "two")])[0]?.items.map((e) => e.id)).toEqual([
		"a",
		"q",
	]);
});

test("words that start a stack hold it open with no thread until the task talks", () => {
	expect(shape([lead("l"), user("q", "two")])).toEqual(["assistant:l", "threads:q:"]);
	expect(shape([lead("l"), user("q", "two"), agent("b", "two")])).toEqual([
		"assistant:l",
		"threads:q:two=q,b",
	]);
});

test("a reply from an earlier card waits for the task's next thread further down", () => {
	const items = [agent("a", "one"), lead("l"), agent("b", "two"), user("u", "one")];
	expect(shape(items)).toEqual(["threads:a:one=a", "assistant:l", "threads:b:two=b"]);
	// Until the task talks, the earlier card keeps its own answer box.
	expect(stacks(items)[0]?.threads[0]?.continuedIn).toBe(null);
	const [first, second] = stacks([...items, agent("c", "one")]);
	expect(first?.threads[0]?.continuedIn).toBe("b");
	const one = second?.threads.find((t) => t.key === "one");
	expect(one?.entries.map((e) => e.id)).toEqual(["u", "c"]);
	expect(one?.earlier.map((e) => e.id)).toEqual(["a"]);
});

test("talk with the Lead in between starts a new stack, and nothing drawn moves", () => {
	expect(
		shape([
			agent("a"),
			user("u"),
			agent("b"),
			lead("l"),
			agent("c"),
			tool("t"),
			agent("d"),
			notice("n"),
			agent("e"),
		]),
	).toEqual([
		"threads:a:fix login=a",
		"user:u",
		"threads:b:fix login=b",
		"assistant:l",
		"threads:c:fix login=c",
		"tools:t:1",
		"threads:d:fix login=d",
		"notice:n",
		"threads:e:fix login=e",
	]);
});

test("a thread that goes on further down carries what came before and is pointed to", () => {
	const [first, second, third] = stacks([
		agent("a"),
		user("u", "fix login"),
		agent("b", "other"),
		lead("l"),
		agent("c"),
		lead("m"),
		agent("d", "other"),
	]);
	const login1 = first?.threads.find((t) => t.key === "fix login");
	const other1 = first?.threads.find((t) => t.key === "other");
	expect(login1?.earlier).toEqual([]);
	expect(login1?.continuedIn).toBe("c");
	expect(second?.threads[0]?.earlier.map((e) => e.id)).toEqual(["a", "u"]);
	expect(second?.threads[0]?.continuedIn).toBe(null);
	expect(other1?.continuedIn).toBe("d");
	expect(third?.threads[0]?.earlier.map((e) => e.id)).toEqual(["b"]);
});

test("the thread takes the task's latest name", () => {
	const renamed: LeadItem = {
		...agent("b"),
		task: { ...task("fix login"), name: "Fix the login" },
	};
	expect(stacks([agent("a"), renamed])[0]?.threads[0]?.task.name).toBe("Fix the login");
});

test("tool calls still fold as before", () => {
	expect(shape([tool("t1"), tool("t2"), agent("a"), tool("t3")])).toEqual([
		"tools:t1:2",
		"threads:a:fix login=a",
		"tools:t3:1",
	]);
});

test("a stack keeps its first entry's id as more join it", () => {
	const before = toLeadBlocks([user("u"), agent("a", "one")]);
	const after = toLeadBlocks([user("u"), agent("a", "one"), agent("b", "two"), agent("c", "one")]);
	expect(before[1]?.kind === "threads" && before[1].id).toBe("a");
	expect(after[1]?.kind === "threads" && after[1].id).toBe("a");
});

test("a stack opens on the task that spoke last and follows new ones", () => {
	expect(shown(FOLLOWING, ["a", "b", "c"])).toBe(2);
	expect(shown(FOLLOWING, ["a", "b", "c", "d"])).toBe(3);
	expect(unseen(FOLLOWING, ["a", "b", "c", "d"], 4)).toBe(false);
});

test("going back holds that thread while more arrive, and flags the new one", () => {
	let v: StackView = goTo(FOLLOWING, 0, ["a", "b", "c"], 3);
	expect(v).toEqual({ at: "a", seen: 3 });
	expect(unseen(v, ["a", "b", "c"], 3)).toBe(false);
	// "b" talks again: it moves to the end, "a" is still the one shown.
	v = arrived(v, ["a", "b", "c"], 3, 4, true);
	expect(shown(v, ["a", "c", "b"])).toBe(0);
	expect(unseen(v, ["a", "c", "b"], 4)).toBe(true);
	// Stepping to one that didn't talk leaves the new one flagged.
	v = goTo(v, 1, ["a", "c", "b"], 4);
	expect(unseen(v, ["a", "c", "b"], 4)).toBe(true);
	// Reaching the newest follows again.
	v = goTo(v, 2, ["a", "c", "b"], 4);
	expect(v.at).toBe(null);
	expect(unseen(v, ["a", "c", "b"], 4)).toBe(false);
});

test("a held thread that talks again moves to the end with the user, unflagged", () => {
	const v = goTo(FOLLOWING, 0, ["a", "b"], 2);
	expect(shown(v, ["b", "a"])).toBe(1);
	expect(unseen(v, ["b", "a"], 3)).toBe(false);
});

test("answering a thread read further back flags nothing: only the tasks' entries count", () => {
	const before = [agent("a", "one"), agent("b", "two")];
	const after = [...before, user("u", "one")];
	const keys = (items: LeadItem[]) => stacks(items)[0]?.threads.map((t) => t.key) ?? [];
	expect(landed(before)).toBe(2);
	expect(landed(after)).toBe(2);
	const v = goTo(FOLLOWING, 0, keys(before), landed(before));
	expect(shown(v, keys(after))).toBe(0);
	expect(unseen(v, keys(after), landed(after))).toBe(false);
});

test("a task talking while the user reads further up doesn't replace the thread shown", () => {
	const v = arrived(FOLLOWING, ["a", "b"], 2, 3, false);
	expect(shown(v, ["a", "b", "c"])).toBe(1);
	expect(unseen(v, ["a", "b", "c"], 3)).toBe(true);
});

test("a task talking while the user is at the bottom is shown", () => {
	expect(arrived(FOLLOWING, ["a", "b"], 2, 3, true)).toBe(FOLLOWING);
});

test("going to a thread out of range lands on the nearest one", () => {
	expect(shown(goTo(FOLLOWING, -1, ["a", "b", "c"], 3), ["a", "b", "c"])).toBe(0);
	expect(goTo(FOLLOWING, 9, ["a", "b", "c"], 3).at).toBe(null);
});

test("a thread opens from its last reply on; before it, each entry folds to a line", () => {
	expect(openFrom(["agent", "user", "agent"])).toBe(2);
	expect(openFrom(["agent", "user"])).toBe(0);
	expect(openFrom(["agent", "agent", "page"])).toBe(1);
	expect(openFrom(["user", "notice"])).toBe(0);
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
