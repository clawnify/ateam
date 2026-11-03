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
 * over another dialog (`busy`). A task's other proposals are not queued behind
 * the one on screen: they count as shown with it (shownWhileOpen).
 */
export function proposalToOpen(
	onScreen: Pick<TaskDTO, "proposals"> | null,
	opened: ReadonlySet<string>,
	busy: boolean,
): string | null {
	if (!onScreen || busy) return null;
	return onScreen.proposals?.find((p) => !opened.has(p.id))?.id ?? null;
}

/**
 * What counts as shown while one of a task's proposals is open: every proposal
 * the task holds, including any that arrive meanwhile. So only the first opens
 * by itself, and the rest wait on the task's strip (ProposalStrip), which the
 * dialog's note points to. Opening them one after another put the next in the
 * closing dialog's place in the same frame, with the same header and the focus
 * in its prompt: it read as the same proposal coming back, and a second ⌘↩
 * would have created it unseen.
 */
export function shownWhileOpen(task: Pick<TaskDTO, "proposals"> | undefined): string[] {
	return task?.proposals?.map((p) => p.id) ?? [];
}
