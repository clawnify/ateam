import { expect, test } from "bun:test";
import type { TaskProposalDTO } from "@ateam/protocol";
import { panelOnScreen, proposalToOpen, shownWhileOpen } from "./proposal-open";

const proposal = (id: string): TaskProposalDTO => ({
	id,
	kind: "task",
	name: `task ${id}`,
	prompt: "x",
	proposedAt: 0,
});
const proposing = { proposals: [proposal("a"), proposal("b")] };

test("opens the oldest proposal not yet shown, each one once", () => {
	expect(proposalToOpen(proposing, new Set(), false)).toBe("a");
	expect(proposalToOpen(proposing, new Set(["a"]), false)).toBe("b");
	expect(proposalToOpen(proposing, new Set(["a", "b"]), false)).toBeNull();
});

// An agent proposing two tasks in a row: creating the first opened the second
// in its place in the same frame, with the same header and the focus in its
// prompt, so it read as the first coming back and a second ⌘↩ created it.
test("a task's other proposals wait on its strip instead of opening next", () => {
	const opened = new Set<string>();
	const first = proposalToOpen(proposing, opened, false);
	expect(first).toBe("a");
	opened.add(first as string);
	// While it is up, the rest count as shown with it.
	for (const id of shownWhileOpen(proposing)) opened.add(id);
	// It closes, however it closes: nothing takes its place.
	expect(proposalToOpen(proposing, opened, false)).toBeNull();
});

test("one that arrives while the dialog is up waits too; one that arrives later opens", () => {
	const opened = new Set<string>(["a"]);
	// The task updates under the open dialog with a new proposal.
	const arrived = { proposals: [proposal("a"), proposal("b")] };
	for (const id of shownWhileOpen(arrived)) opened.add(id);
	expect(proposalToOpen(arrived, opened, false)).toBeNull();
	// With no proposal dialog up, a new one is news and opens by itself.
	const later = { proposals: [proposal("a"), proposal("b"), proposal("c")] };
	expect(proposalToOpen(later, opened, false)).toBe("c");
});

test("a task holding no proposals, or gone from the board, marks nothing", () => {
	expect(shownWhileOpen(undefined)).toEqual([]);
	expect(shownWhileOpen({ proposals: null })).toEqual([]);
});

test("waits while another dialog is up, and needs the proposing task on screen", () => {
	expect(proposalToOpen(proposing, new Set(), true)).toBeNull();
	expect(proposalToOpen(null, new Set(), false)).toBeNull();
	expect(proposalToOpen({ proposals: null }, new Set(), false)).toBeNull();
});

test("a task's panel is on screen full width over any view, or beside the board", () => {
	expect(panelOnScreen("board", "side", false)).toBe(true);
	expect(panelOnScreen("mission", "full", false)).toBe(true);
	// Mission Control's grid and the Lead show no panel beside them.
	expect(panelOnScreen("mission", "side", false)).toBe(false);
	expect(panelOnScreen("lead", "side", false)).toBe(false);
	// A task whose box is out of reach shows its wake card, not its panel.
	expect(panelOnScreen("board", "full", true)).toBe(false);
});
