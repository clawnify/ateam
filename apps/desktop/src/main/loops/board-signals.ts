import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AteamDb, KanbanColumn, Task } from "@ateam/db";
import { repo } from "@ateam/db";
import { validateSetStatus } from "./board-organizer";
import { agentAlive } from "./session-liveness";
import { type TriageResult, triageWorktree, type WorktreeSignals } from "./worktree-triage";

/**
 * I/O adapter between the board and the organizer's tools. Gathers the per-task
 * signals `triageWorktree` needs, exposes the board as the `get_board` payload,
 * and applies a guarded `set_status`. All impurity (git/gh/pid/db) lives here;
 * the judgment (`triageWorktree`) and the guardrail (`validateSetStatus`) stay
 * pure and tested next door.
 *
 * NOTE (status detection): `claude agents --json` is the richest liveness/
 * blocking signal (see agent-loops.design.md), but it covers backgrounded
 * agents, not Ateam's interactive PTY sessions — so we key liveness off pid
 * here and leave agents-polling for the backgrounded-organizer path.
 */

const pexec = promisify(execFile);

/** One task as the organizer sees it — its board column plus the triage verdict. */
export interface BoardTaskView {
	taskId: string;
	name: string;
	projectId: string;
	column: KanbanColumn;
	branch: string;
	prNumber: number | null;
	agentAlive: boolean;
	/** The done-vs-ongoing judgment the organizer reasons with. */
	triage: TriageResult;
}

export interface BoardView {
	generatedAt: number;
	tasks: BoardTaskView[];
}

/** PR state + merge time in one gh call; null on any failure (offline / no PR). */
async function prMergeInfo(
	worktreePath: string,
): Promise<{ state: WorktreeSignals["prState"]; mergedAtMs: number | null }> {
	try {
		const { stdout } = await pexec("gh", ["pr", "view", "--json", "state,mergedAt"], {
			cwd: worktreePath,
		});
		const p = JSON.parse(stdout) as { state?: string; mergedAt?: string | null };
		const state =
			p.state === "OPEN" || p.state === "MERGED" || p.state === "CLOSED" ? p.state : null;
		const mergedAtMs = p.mergedAt ? Date.parse(p.mergedAt) : null;
		return { state, mergedAtMs: Number.isNaN(mergedAtMs) ? null : mergedAtMs };
	} catch {
		return { state: null, mergedAtMs: null };
	}
}

/** Gather the signals for one task. Cheap fields come from the DB snapshot;
 *  the gh call is made only when a PR could plausibly exist. */
async function gatherSignals(db: AteamDb, task: Task): Promise<WorktreeSignals> {
	const gs = task.gitStatus;
	const mightHavePr = task.prNumber != null || task.column === "review" || task.column === "merged";
	const pr = mightHavePr ? await prMergeInfo(task.worktreePath) : { state: null, mergedAtMs: null };

	return {
		agentAlive: agentAlive(db, task.id),
		createdAtMs: task.createdAt ?? null,
		// gitStatus.updatedAt tracks the last git refresh; lastEventAt tracks the
		// last hook activity (our best proxy for conversation activity).
		indexMtimeMs: gs?.updatedAt ?? null,
		transcriptMtimeMs: task.lastEventAt ?? null,
		dirtyRealCount: gs?.dirty ?? 0,
		commitsAhead: gs?.ahead ?? 0,
		prState: pr.state,
		mergedAtMs: pr.mergedAtMs,
	};
}

/**
 * Build the `get_board` payload: every non-merged task with its triage verdict.
 * `merged` is terminal ground truth, so those are excluded — the organizer acts
 * on what's still in play.
 */
export async function buildBoardView(db: AteamDb, now = Date.now()): Promise<BoardView> {
	const tasks: BoardTaskView[] = [];
	for (const project of repo.listProjects(db)) {
		for (const task of repo.listTasks(db, project.id)) {
			if (task.column === "merged") continue;
			const signals = await gatherSignals(db, task);
			tasks.push({
				taskId: task.id,
				name: task.name,
				projectId: project.id,
				column: task.column,
				branch: task.branch,
				prNumber: task.prNumber ?? null,
				agentAlive: signals.agentAlive ?? false,
				triage: triageWorktree(signals, { now }),
			});
		}
	}
	return { generatedAt: now, tasks };
}

export interface ApplySetStatusResult {
	ok: boolean;
	/** Human-readable outcome — the move made, or why it was refused. */
	reason: string;
}

/**
 * Apply one proposed move. `to`/`reason` come from the caller (untrusted);
 * `from` is read from the DB (trusted). The caller is identified by its terminal:
 * a session whose terminal maps to THIS task is a self-move (may move its own
 * card even while live); anything else is the organizer (external). A session
 * may only move its OWN task. The guardrail decides; an approved move updates
 * the card AND writes an audit row.
 */
export function applySetStatus(
	db: AteamDb,
	input: { taskId: string; to: string; reason?: string; callerTerminalId?: string },
	onTaskUpdated: (taskId: string) => void,
): ApplySetStatusResult {
	const task = repo.getTask(db, input.taskId);
	if (!task) return { ok: false, reason: `unknown task: ${input.taskId}` };

	// Who's calling? A terminal that belongs to a task makes this a session move.
	const callerTaskId = input.callerTerminalId
		? repo.getSessionByTerminal(db, input.callerTerminalId)?.taskId
		: undefined;
	if (callerTaskId != null && callerTaskId !== task.id) {
		return { ok: false, reason: "a session may only change its own task" };
	}
	const bySelf = callerTaskId != null && callerTaskId === task.id;

	const verdict = validateSetStatus({
		taskId: task.id,
		from: task.column,
		to: input.to as KanbanColumn,
		agentAlive: agentAlive(db, task.id),
		bySelf,
		reason: input.reason,
	});
	if (!verdict.ok) return { ok: false, reason: verdict.reason };

	repo.updateTask(db, task.id, { column: verdict.change.to });
	repo.recordBoardChange(db, {
		taskId: task.id,
		fromColumn: verdict.change.from,
		toColumn: verdict.change.to,
		reason: verdict.change.reason,
		source: bySelf ? "session" : "organizer",
	});
	onTaskUpdated(task.id);
	return { ok: true, reason: `moved "${verdict.change.from}" → "${verdict.change.to}"` };
}
