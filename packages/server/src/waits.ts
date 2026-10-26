/**
 * Waits: a task parked on an outside party (a review, an approval, an email,
 * someone else's job finishing) until a date. The snooze the board needs for
 * work nobody can advance yet, and the reminder for "after X, check Y".
 *
 * What is stored is three columns on the task: what it waits for, when to
 * chase it, and when it was chased. What this module owns is the lifecycle:
 *
 *   - SET, by the task's own agent through the board MCP tool (it is the one
 *     that just told the user "this is a waiting game now") or by the user from
 *     the sidebar. Guarded like `set_status`: a session may only park its own
 *     task, the reason is required, and the date must be ahead but not absurd.
 *   - RESURFACE, when the date passes: the card is filed in Needs You and
 *     flagged unread, once, and `waitingFiredAt` records that it happened so a
 *     restart does not do it again (and clients notify exactly once). The
 *     reason and date stay set so the card can still say what it was waiting
 *     for.
 *   - CLEAR, when someone comes back to a wait that has FIRED: the user
 *     replying, or a fresh launch. A wait still pending is not ended by either.
 *     It is about the outside party, not about the user's attention, so
 *     chatting in the task at 15:00 must not cancel the 22:00 "the nightly run
 *     is done, check it". Only clearing it by hand (or re-setting it) does.
 *
 * Timers live in the process; the schedule lives in the row. Boot re-arms every
 * pending wait from the table, and an overdue one fires right away, the same
 * shape as the loop runner, which is where this pattern was already proven. One
 * more thing the runner never needed: `setTimeout` overflows past ~24.8 days and
 * fires immediately, so a long wait is armed in chunks and re-checked on each.
 */

import type { AteamDb, Task } from "@ateam/db";
import { repo } from "@ateam/db";

/** Longest a single wait may be. A year is "someday", not a date to chase. */
export const MAX_WAIT_MS = 365 * 24 * 3600_000;
/** Longest delay Node's setTimeout takes without overflowing (2^31 - 1). */
const MAX_TIMER_MS = 2_147_483_647;
const MAX_REASON_CHARS = 200;

/** The patch that ends a wait, whoever ends it. */
export const CLEAR_WAIT = {
	waitingReason: null,
	waitingUntil: null,
	waitingFiredAt: null,
} as const;

export type WaitVerdict =
	| { ok: true; reason: string; until: number }
	| { ok: false; reason: string };

/**
 * Check a proposed wait. `until` is epoch ms; the MCP layer parses the model's
 * ISO string before it gets here so both callers share one rule.
 */
export function validateWait(
	input: { reason: unknown; until: unknown },
	now = Date.now(),
): WaitVerdict {
	const reason = typeof input.reason === "string" ? input.reason.trim() : "";
	if (!reason) return { ok: false, reason: "say what the task is waiting for" };
	if (reason.length > MAX_REASON_CHARS) {
		return { ok: false, reason: `reason is too long (max ${MAX_REASON_CHARS} chars)` };
	}
	const until = typeof input.until === "number" ? input.until : Number.NaN;
	if (!Number.isFinite(until)) return { ok: false, reason: "until must be a date" };
	if (until <= now) return { ok: false, reason: "until must be in the future" };
	if (until > now + MAX_WAIT_MS) return { ok: false, reason: "until must be within a year" };
	return { ok: true, reason, until };
}

/**
 * Park a task. The caller is identified by its terminal, exactly as in
 * `applySetStatus`: a session may only park its OWN task, and it need not name
 * it, since a session has no other way to learn its task id, so no `taskId`
 * means "mine". No terminal means the user (the sidebar) or a debug endpoint,
 * and those must say which task.
 */
export function applySetWaiting(
	db: AteamDb,
	input: { taskId?: string; reason: unknown; until: unknown; callerTerminalId?: string },
	waits: WaitTimers,
	onTaskUpdated: (taskId: string) => void,
	now = Date.now(),
): { ok: boolean; reason: string } {
	const callerTaskId = input.callerTerminalId
		? repo.getSessionByTerminal(db, input.callerTerminalId)?.taskId
		: undefined;
	const taskId = input.taskId || callerTaskId;
	if (!taskId)
		return { ok: false, reason: "which task? no taskId and no session to infer it from" };
	const task = repo.getTask(db, taskId);
	if (!task) return { ok: false, reason: `unknown task: ${taskId}` };
	if (callerTaskId != null && callerTaskId !== task.id) {
		return { ok: false, reason: "a session may only park its own task" };
	}
	const verdict = validateWait(input, now);
	if (!verdict.ok) return verdict;
	repo.updateTask(db, task.id, {
		waitingReason: verdict.reason,
		waitingUntil: verdict.until,
		waitingFiredAt: null,
	});
	waits.arm(task.id, verdict.until);
	onTaskUpdated(task.id);
	return {
		ok: true,
		reason: `parked "${task.name}" for ${verdict.reason}; it resurfaces in Needs You at ${new Date(verdict.until).toISOString()} (in ${untilText(verdict.until - now)}) and the user is notified`,
	};
}

function untilText(ms: number): string {
	const hours = ms / 3_600_000;
	if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
	if (hours < 48) return `${Math.round(hours)}h`;
	return `${Math.round(hours / 24)}d`;
}

/** End a wait, if there is one. Returns whether anything changed. */
export function clearWaiting(db: AteamDb, task: Task): boolean {
	if (task.waitingUntil == null && task.waitingReason == null) return false;
	repo.updateTask(db, task.id, CLEAR_WAIT);
	return true;
}

/**
 * Has this wait already resurfaced? Only then does the user's activity end it;
 * a pending wait keeps ringing at its date.
 */
export function isFiredWait(task: Pick<Task, "waitingFiredAt">): boolean {
	return task.waitingFiredAt != null;
}

/**
 * The due moment for one task: file it in Needs You, flag it unread and stamp
 * `waitingFiredAt`. Skips a card whose wait was cleared, moved or already
 * fired since the timer was armed, and never moves a card an agent is live in:
 * `running` is the hooks' column.
 */
export function expireWait(db: AteamDb, taskId: string, now = Date.now()): boolean {
	const task = repo.getTask(db, taskId);
	if (!task || task.waitingUntil == null || task.waitingUntil > now) return false;
	if (task.waitingFiredAt != null) return false;
	repo.updateTask(db, task.id, {
		isUnread: true,
		waitingFiredAt: now,
		...(task.column === "running" ? {} : { column: "needs_attention" }),
	});
	return true;
}

export interface WaitTimerDeps {
	db: AteamDb;
	/** Called after a wait came due and the card was updated. */
	onExpired: (taskId: string) => void;
	now?: () => number;
	/** Injectable for tests; defaults to the real timers. */
	setTimeout?: (fn: () => void, ms: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
}

export class WaitTimers {
	private timers = new Map<string, unknown>();
	private readonly now: () => number;
	private readonly setTimer: (fn: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;

	constructor(private readonly deps: WaitTimerDeps) {
		this.now = deps.now ?? Date.now;
		this.setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearTimer = deps.clearTimeout ?? ((h) => clearTimeout(h as NodeJS.Timeout));
	}

	/** Re-arm every pending wait from the table. Overdue ones fire at once. */
	start(): void {
		for (const t of repo.listPendingWaits(this.deps.db)) {
			if (t.waitingUntil != null) this.arm(t.id, t.waitingUntil);
		}
	}

	stop(): void {
		for (const h of this.timers.values()) this.clearTimer(h);
		this.timers.clear();
	}

	/**
	 * The earliest pending wait, or null. A box that sleeps when idle must wake
	 * for it the same way it wakes for its next loop tick (cli.ts), or a wait
	 * on a remote box is slept straight through.
	 */
	nextDueAt(): number | null {
		let next: number | null = null;
		for (const t of repo.listPendingWaits(this.deps.db)) {
			if (t.waitingUntil != null && (next == null || t.waitingUntil < next)) next = t.waitingUntil;
		}
		return next;
	}

	/** Schedule (or reschedule) the resurface for one task. */
	arm(taskId: string, until: number): void {
		this.disarm(taskId);
		const delay = Math.max(0, Math.min(until - this.now(), MAX_TIMER_MS));
		const handle = this.setTimer(() => {
			this.timers.delete(taskId);
			// Chunked: a long wait re-checks the row rather than trusting the
			// original delay, so a wait extended meanwhile is honoured too.
			const task = repo.getTask(this.deps.db, taskId);
			if (!task || task.waitingUntil == null || task.waitingFiredAt != null) return;
			if (task.waitingUntil > this.now()) {
				this.arm(taskId, task.waitingUntil);
				return;
			}
			if (expireWait(this.deps.db, taskId, this.now())) this.deps.onExpired(taskId);
		}, delay);
		this.timers.set(taskId, handle);
	}

	private disarm(taskId: string): void {
		const h = this.timers.get(taskId);
		if (h !== undefined) {
			this.clearTimer(h);
			this.timers.delete(taskId);
		}
	}

	/** Armed count, for tests. */
	get size(): number {
		return this.timers.size;
	}
}
