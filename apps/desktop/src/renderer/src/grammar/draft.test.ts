import { expect, test } from "bun:test";
import { DraftTracker, retype } from "./draft";

/** Feed each chunk the way xterm's onData delivers keystrokes. */
const typed = (...chunks: string[]) => {
	const t = new DraftTracker();
	for (const c of chunks) t.feed(c);
	return t.draft;
};

test("typed keys build the draft, one onData chunk per key", () => {
	expect(typed(..."fix the bug")).toBe("fix the bug");
});

test("backspace removes the last character, including an emoji whole", () => {
	expect(typed("helo", "\x7f", "\x7f", "llo")).toBe("hello");
	expect(typed("ok 👍", "\x7f")).toBe("ok ");
});

test("Enter submits and empties the draft", () => {
	expect(typed("first prompt", "\r", "next")).toBe("next");
});

test("backslash + Enter and Option+Enter add a newline instead of submitting", () => {
	expect(typed("line one\\", "\r", "line two")).toBe("line one\nline two");
	expect(typed("line one", "\x1b\r", "line two")).toBe("line one\nline two");
});

test("word and line kills", () => {
	expect(typed("fix the bug ", "\x17")).toBe("fix the ");
	expect(typed("fix the bug", "\x1b\x7f")).toBe("fix the ");
	expect(typed("keep\x1b\rdrop this", "\x15")).toBe("keep\n");
	expect(typed("throw away", "\x03")).toBe("");
});

test("bracketed paste lands verbatim, CRLF normalised", () => {
	expect(typed("see ", "\x1b[200~a\r\nb\x1b[201~", " ok")).toBe("see a\nb ok");
});

test("caret movement, history and completion lose the draft until the next submit", () => {
	expect(typed("fix the bug", "\x1b[D")).toBeNull(); // left arrow
	expect(typed("fix", "\x1b[A")).toBeNull(); // history
	expect(typed("@src/ma", "\t")).toBeNull(); // completion
	expect(typed("fix", "\x1b")).toBeNull(); // lone Esc
	expect(typed("fix", "\x1bOD")).toBeNull(); // SS3 arrow
	// Once lost, typing doesn't resurrect a wrong draft…
	expect(typed("fix", "\x1b[D", "x")).toBeNull();
	// …but submitting (or Ctrl+C) puts us back in sync.
	expect(typed("fix", "\x1b[D", "\r", "new")).toBe("new");
	expect(typed("fix", "\x1b[D", "\x03", "new")).toBe("new");
});

test("focus and mouse reports leave the draft alone", () => {
	expect(typed("fix", "\x1b[O", "\x1b[I", " it")).toBe("fix it");
	expect(typed("fix", "\x1b[<64;10;5M", "\x1b[<0;3;4m", " it")).toBe("fix it");
	expect(typed("fix", "\x1b[M`!!", " it")).toBe("fix it");
});

test("retype backspaces only to the first difference, and replays into the fixed draft", () => {
	const fix = (from: string, to: string) => {
		const { backspaces, tail } = retype(from, to);
		const t = new DraftTracker();
		t.feed(`\x1b[200~${from}\x1b[201~`);
		for (let i = 0; i < backspaces; i++) t.feed("\x7f");
		t.feed(tail.includes("\n") ? `\x1b[200~${tail}\x1b[201~` : tail);
		expect(t.draft).toBe(to);
		return { backspaces, tail };
	};
	expect(fix("fix the bug wich", "fix the bug which")).toEqual({ backspaces: 3, tail: "hich" });
	expect(fix("the the bug", "the bug")).toEqual({ backspaces: 7, tail: "bug" });
	expect(fix("dont stop\nnow 👍", "don't stop\nnow 👍")).toEqual({
		backspaces: 12,
		tail: "'t stop\nnow 👍",
	});
});
