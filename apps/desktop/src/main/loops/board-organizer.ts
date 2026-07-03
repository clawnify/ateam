/**
 * Board organizer — safety rail for board moves made through the MCP `set_status`
 * tool, whether by the write-capable organizer loop OR by a task's own agent
 * session (see agent-loops.design.md). An LLM mutating board state is the
 * accepted risk, so every move is validated here before it touches the DB. The
 * caller proposes; this disposes.
 *
 * The column model has two kinds:
 *   • ASSIGNABLE (`todo`, `review`) — judgment columns a caller may set.
 *   • PROGRAMMATIC (`running`, `needs_attention`, `merged`) — set only by real
 *     events / lifecycle hooks: `running` on agent launch, `needs_attention`
 *     when the agent blocks on input (programmatic, not a judgment call),
 *     `merged` on a real merge. Nobody targets these through the tool.
 *
 * Two callers, two trust levels:
 *   • ORGANIZER (external, board-level): may re-triage cards among the assignable
 *     columns, but never touches a card with a LIVE agent or one sitting in a
 *     programmatic column — those belong to real events, not the organizer.
 *   • SELF (`bySelf`): a task's own session moving its OWN card. It IS the live
 *     agent, so the live-agent guard doesn't apply — it may retarget its card
 *     (e.g. "I'm done" → `review`). It still cannot un-`merged` a card.
 *
 * Every approved move yields a `BoardChange` for the audit log, so a misfile is
 * always traceable and reversible.
 *
 * Pure module: no db, no I/O, no clock. Unit-tested in
 * apps/desktop/test/board-organizer.test.ts.
 */

import type { KanbanColumn } from "@ateam/db";

/** Columns a caller MAY set through the tool — the judgment columns. */
export const ASSIGNABLE_COLUMNS = ["todo", "review"] as const;

/** Columns set only by real events / hooks; never a tool target. */
export const PROGRAMMATIC_COLUMNS = ["running", "needs_attention", "merged"] as const;

export type AssignableColumn = (typeof ASSIGNABLE_COLUMNS)[number];

export function isAssignable(col: KanbanColumn): col is AssignableColumn {
	return (ASSIGNABLE_COLUMNS as readonly string[]).includes(col);
}

export function isProgrammatic(col: KanbanColumn): boolean {
	return (PROGRAMMATIC_COLUMNS as readonly string[]).includes(col);
}

/** A proposed move. `from` is server-supplied (read from the DB), not taken from
 *  the caller — the caller only names the target and its reason. */
export interface SetStatusRequest {
	taskId: string;
	/** The card's current column, read from the DB (not from the caller). */
	from: KanbanColumn;
	/** Where the caller wants the card to go. */
	to: KanbanColumn;
	/** Whether a live agent is currently working this task. */
	agentAlive: boolean;
	/** True when the caller is the task's OWN session moving its OWN card. */
	bySelf?: boolean;
	/** The caller's justification — recorded in the audit trail. */
	reason?: string;
}

/** An approved change, ready to apply + audit. Timestamped at persistence. */
export interface BoardChange {
	taskId: string;
	from: KanbanColumn;
	to: KanbanColumn;
	reason: string;
}

export type SetStatusVerdict = { ok: true; change: BoardChange } | { ok: false; reason: string };

/**
 * Validate one proposed move. Checks are ordered most-fundamental first so the
 * reason returned is the most relevant. A rejected move is a no-op the caller
 * records as skipped — never an error that stops the loop.
 */
export function validateSetStatus(req: SetStatusRequest): SetStatusVerdict {
	if (req.to === req.from) {
		return { ok: false, reason: `no-op: card already in "${req.from}"` };
	}
	if (!isAssignable(req.to)) {
		return {
			ok: false,
			reason: `cannot set "${req.to}" — it is set only by real events (launch / awaiting-input / merge)`,
		};
	}
	// Terminal state: even the card's own session can't un-merge it.
	if (req.from === "merged") {
		return { ok: false, reason: `cannot move a card out of "merged" — the merge is real` };
	}

	// A session moving its OWN card owns it — the live-agent / programmatic-column
	// guards below are about protecting a card from OTHER movers, so skip them.
	if (req.bySelf) {
		return { ok: true, change: approved(req, "session self-move") };
	}

	// Organizer / external path.
	if (isProgrammatic(req.from)) {
		return {
			ok: false,
			reason: `cannot move a card out of "${req.from}" — it is owned by ${ownerOf(req.from)}, not the organizer`,
		};
	}
	if (req.agentAlive) {
		return {
			ok: false,
			reason: "task has a live agent — the agent and its hooks own this card",
		};
	}
	return { ok: true, change: approved(req, "organizer re-triage") };
}

function approved(req: SetStatusRequest, fallbackReason: string): BoardChange {
	return {
		taskId: req.taskId,
		from: req.from,
		to: req.to,
		reason: req.reason?.trim() || fallbackReason,
	};
}

function ownerOf(col: KanbanColumn): string {
	if (col === "merged") return "the merge queue";
	if (col === "needs_attention") return "the input-request hooks";
	return "the running agent";
}
