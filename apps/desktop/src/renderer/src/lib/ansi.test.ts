import { describe, expect, it } from "bun:test";
import { stripAnsi } from "./ansi";

describe("stripAnsi", () => {
	it("drops the colour codes an installer prints, keeping its words", () => {
		// What OpenCode's installer printed into Create a box's log (2026-11-04).
		const out =
			"\x1b[0;2mOpenCode includes free models, to start: \x1b[0m\nopencode \x1b[0;2m# Run command \x1b[0m";
		expect(stripAnsi(out)).toBe(
			"OpenCode includes free models, to start: \nopencode # Run command ",
		);
	});

	it("drops a terminal title or link, and a stray escape", () => {
		expect(stripAnsi("\x1b]0;title\x07done\x1b")).toBe("done");
		expect(stripAnsi("\x1b]8;;https://x.dev\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
	});

	it("leaves plain text alone, brackets included", () => {
		expect(stripAnsi("[ok] node 22 [--] tailscale")).toBe("[ok] node 22 [--] tailscale");
	});
});
