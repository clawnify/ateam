import { expect, test } from "bun:test";
import type { TaskProposalDTO } from "@ateam/protocol";
import { panelOnScreen, proposalToOpen } from "./proposal-open";

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
