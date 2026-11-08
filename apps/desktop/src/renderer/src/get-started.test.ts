// When Get started takes the board's place.
import { describe, expect, it } from "bun:test";
import { nextGetStarted, showsGetStarted } from "./get-started";

const board = (
	projectCount: number,
	taskCount: number,
	more: { loaded?: boolean; bound?: boolean } = {},
) => ({
	projectsLoaded: more.loaded ?? true,
	bound: more.bound ?? false,
	projectCount,
	taskCount,
});

describe("Get started", () => {
	it("stays for a new install through its first project, until the first task", () => {
		let state = nextGetStarted(null, board(0, 0));
		expect(state).toBe("open");
		expect(showsGetStarted(state, board(0, 0))).toBe(true);
		// A project added from it: the list stays for the steps after.
		state = nextGetStarted(state, board(1, 0));
		expect(showsGetStarted(state, board(1, 0))).toBe(true);
		// The first task: the board takes over, for good.
		state = nextGetStarted(state, board(1, 1));
		expect(state).toBe("done");
		expect(showsGetStarted(state, board(2, 0))).toBe(false);
	});

	it("never shows on an install that already has projects, even while their tasks load", () => {
		const state = nextGetStarted(null, board(3, 0));
		expect(state).toBe("done");
		expect(showsGetStarted(state, board(3, 0))).toBe(false);
	});

	it("comes back with no project at all, as it always has", () => {
		expect(showsGetStarted("done", board(0, 0))).toBe(true);
	});

	it("waits for the projects, and never takes a project window's board", () => {
		expect(nextGetStarted(null, board(0, 0, { loaded: false }))).toBeNull();
		expect(showsGetStarted("open", board(0, 0, { loaded: false }))).toBe(false);
		expect(nextGetStarted(null, board(1, 0, { bound: true }))).toBeNull();
		expect(showsGetStarted("open", board(1, 0, { bound: true }))).toBe(false);
	});
});
