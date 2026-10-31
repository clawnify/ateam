// When a task or loop an agent proposed opens its dialog by itself (see
// proposals.ts in the server). Pure, so the rule is tested apart from App.
import type { TaskDTO } from "@ateam/protocol";

/**
 * Whether the selected task's panel is on screen: open full width over any
 * view, or beside the board. Mission Control's grid, the Loops list and the
 * Lead show no panel beside them, and a task whose box is out of reach shows
 * its wake card instead. Mirrors App's panel branches.
 */
export function panelOnScreen(view: string, panelMode: "side" | "full", offline: boolean): boolean {
	return !offline && (panelMode === "full" || view === "board");
}

/**
 * The proposal whose dialog opens by itself now, or null. Only the task on
 * screen qualifies (`onScreen`): a dialog from a task you are not looking at
 * would arrive with no context for what it is about. Each proposal opens
 * unasked once (`opened` holds those already shown), oldest first, and never
 * over another dialog (`busy`): it waits for that one to close.
 */
export function proposalToOpen(
	onScreen: Pick<TaskDTO, "proposals"> | null,
	opened: ReadonlySet<string>,
	busy: boolean,
): string | null {
	if (!onScreen || busy) return null;
	return onScreen.proposals?.find((p) => !opened.has(p.id))?.id ?? null;
}
