/**
 * Triage straight from a task row — no git, no gh, no subprocess.
 *
 * `triageWorktree` already answers "is this done or still ongoing, and why",
 * but its only caller was the board organizer's MCP `get_board` tool, which
 * shells out to `gh pr view` per task. That is fine for one LLM turn and far
 * too expensive to hang a UI off. Nearly every signal it wants is already
 * persisted on the task, so this maps the row directly and gives every client
 * the same verdict for free on every DTO.
 *
 * Fidelity note: `mergedAtMs` is NOT persisted, so the "merged but the
 * conversation kept going" gap always reads as 0 here and a merged task
 * classifies as `merged_done`. The gh-backed path in board-signals still makes
 * that distinction. Persisting the merge time (the merge queue knows it) would
 * close the gap; until then this is honest about erring toward `merged_done`
 * for cards that are already in the Done column anyway.
 *
 * Pure module: no db, no I/O; `now` is injected. Unit-tested in
 * test/task-triage.test.ts.
 */

import type { Task } from "@ateam/db";
import type { TaskTriage } from "@ateam/protocol";
import { triageWorktree, type WorktreeSignals } from "./loops/worktree-triage";

/** The DB's PrState is lowercase; WorktreeSignals speaks gh's uppercase. */
function toPrState(s: Task["prState"]): WorktreeSignals["prState"] {
	if (s === "open") return "OPEN";
	if (s === "merged") return "MERGED";
	if (s === "closed") return "CLOSED";
	return null;
}

/**
 * The signals a task row can answer on its own. Callers with richer evidence
 * (a live pid, a fresh `gh pr view`) spread this and override those fields —
 * see board-signals.gatherSignals.
 */
export function signalsFromTask(task: Task): WorktreeSignals {
	const gs = task.gitStatus;
	return {
		// The persisted status is trustworthy now that a reconnect closes out
		// sessions whose exit went unobserved (see pty/stranded.ts).
		agentAlive: task.agentStatus === "running" || task.agentStatus === "awaiting_input",
		// Parked on a question, not stuck — keeps the stall rule off it.
		agentAwaitingInput: task.agentStatus === "awaiting_input",
		createdAtMs: task.createdAt ?? null,
		// gitStatus.updatedAt tracks the last git refresh; lastEventAt tracks the
		// last hook activity (our best proxy for conversation activity).
		indexMtimeMs: gs?.updatedAt ?? null,
		transcriptMtimeMs: task.lastEventAt ?? null,
		dirtyRealCount: gs?.dirty ?? 0,
		commitsAhead: gs?.ahead ?? 0,
		prState: toPrState(task.prState),
		mergedAtMs: null,
	};
}

/** One task's verdict, as carried on its DTO. */
export function triageTask(task: Task, now = Date.now()): TaskTriage {
	const { bucket, done, reason } = triageWorktree(signalsFromTask(task), { now });
	return { bucket, done, reason };
}
