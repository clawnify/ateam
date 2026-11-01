import { expect, test } from "bun:test";
import {
	type DraftRef,
	expandRefs,
	matchTasks,
	type RefTask,
	refQuery,
	splitDraft,
	splitSent,
	tokenFor,
} from "./lead-refs";

const task = (id: string, name: string, at = 0, extra: Partial<RefTask> = {}): RefTask => ({
	id,
	name,
	branch: name.toLowerCase().replace(/\W+/g, "-"),
	projectId: "p1",
	lastEventAt: at,
	...extra,
});
const projects: Record<string, string> = { p1: "ateam", p2: "website" };
const projectName = (id: string) => projects[id];

test("an @ at the start or after a space opens the list, with what follows it", () => {
	expect(refQuery("@", 1, [])).toEqual({ start: 0, query: "" });
	expect(refQuery("ask @fix lo", 11, [])).toEqual({ start: 4, query: "fix lo" });
	// Only what is before the caret counts.
	expect(refQuery("ask @fix login", 8, [])).toEqual({ start: 4, query: "fix" });
	expect(refQuery("line one\n@fi", 12, [])).toEqual({ start: 9, query: "fi" });
});

test("an @ inside a word (an email), a space after it, or a new line keeps the list closed", () => {
	expect(refQuery("mail me@example.com", 19, [])).toBeNull();
	expect(refQuery("meet @ 5", 8, [])).toBeNull();
	expect(refQuery("@fix\nmore", 9, [])).toBeNull();
	expect(refQuery("no trigger", 10, [])).toBeNull();
	// A slash is Claude's own: /push goes to it as a command, untouched.
	expect(refQuery("/push", 5, [])).toBeNull();
});

test("a task already picked does not reopen the list", () => {
	const refs: DraftRef[] = [{ token: "@Fix login", taskId: "a" }];
	expect(refQuery("@Fix login ", 11, refs)).toBeNull();
	// Edited, it no longer stands for the task: the list offers it again.
	expect(refQuery("@Fix logi", 9, refs)).toEqual({ start: 0, query: "Fix logi" });
});

test("matches rank the name's start first, then a word's start, newest first within each", () => {
	const tasks = [
		task("a", "Prefix the docs", 30),
		task("b", "Fix login page", 10),
		task("c", "Make fixtures", 50),
		task("d", "fix the build", 20),
		task("e", "Unrelated", 99),
	];
	expect(matchTasks(tasks, "fix", projectName).map((t) => t.id)).toEqual(["d", "b", "c", "a"]);
});

test("an empty query lists every task, newest first, up to the limit", () => {
	const tasks = [task("a", "One", 1), task("b", "Two", 3), task("c", "Three", 2)];
	expect(matchTasks(tasks, "", projectName).map((t) => t.id)).toEqual(["b", "c", "a"]);
	expect(matchTasks(tasks, "", projectName, 2).map((t) => t.id)).toEqual(["b", "c"]);
});

test("every word must appear in the name, the branch or the project", () => {
	const tasks = [
		task("a", "Fix login page", 1),
		task("b", "Fix login page", 2, { projectId: "p2", branch: "auth-redo" }),
	];
	expect(matchTasks(tasks, "login fix", projectName).map((t) => t.id)).toEqual(["b", "a"]);
	expect(matchTasks(tasks, "fix website", projectName).map((t) => t.id)).toEqual(["b"]);
	expect(matchTasks(tasks, "auth", projectName).map((t) => t.id)).toEqual(["b"]);
	expect(matchTasks(tasks, "fix the bug please", projectName)).toEqual([]);
});

test("a token is the name on one line, with the branch when the draft already uses that name", () => {
	const a = task("a", "Fix  login\npage");
	expect(tokenFor(a, [])).toBe("@Fix login page");
	const b = task("b", "Fix login page", 0, { branch: "fix-login-page-2" });
	const refs = [{ token: "@Fix login page", taskId: "a" }];
	expect(tokenFor(b, refs)).toBe("@Fix login page (fix-login-page-2)");
	// The same task picked again keeps its token.
	expect(tokenFor(task("a", "Fix login page"), refs)).toBe("@Fix login page");
	expect(tokenFor(task("x", "  ", 0, { branch: "untitled" }), [])).toBe("@untitled");
});

test("sending turns each picked token into the Lead's own task link", () => {
	const refs: DraftRef[] = [
		{ token: "@Fix", taskId: "short" },
		{ token: "@Fix login", taskId: "long" },
	];
	expect(expandRefs("ask @Fix login and @Fix to sync", refs)).toBe(
		"ask [Fix login](task:long) and [Fix](task:short) to sync",
	);
	// Not picked, or edited since: sent as written.
	expect(expandRefs("@Other and @Fi login", refs)).toBe("@Other and @Fi login");
	expect(expandRefs("plain", [])).toBe("plain");
});

test("brackets in a name are escaped in the link and come back in the chip", () => {
	const refs = [{ token: "@Port [WIP] notes", taskId: "w" }];
	const sent = expandRefs("see @Port [WIP] notes", refs);
	expect(sent).toBe("see [Port \\[WIP\\] notes](task:w)");
	expect(splitSent(sent)).toEqual([{ text: "see " }, { label: "Port [WIP] notes", target: "w" }]);
});

test("the draft splits into text and picked tokens for the highlight", () => {
	const refs = [{ token: "@Fix login", taskId: "a" }];
	expect(splitDraft("ask @Fix login now", refs)).toEqual([
		{ text: "ask " },
		{ text: "@Fix login", ref: refs[0] },
		{ text: " now" },
	]);
	expect(splitDraft("nothing picked", refs)).toEqual([{ text: "nothing picked" }]);
});

test("a sent message splits into text and task links, other links left as text", () => {
	expect(splitSent("ask [Fix login](task:abc) about [docs](https://x.y)\nthanks")).toEqual([
		{ text: "ask " },
		{ label: "Fix login", target: "abc" },
		{ text: " about [docs](https://x.y)\nthanks" },
	]);
	expect(splitSent("no links")).toEqual([{ text: "no links" }]);
});
