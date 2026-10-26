// Phone notifications for task waits (see packages/server/src/waits.ts).
//
// The box resurfaces a wait on its board when it comes due, but nothing reaches
// a phone in a pocket: Ateam Go has no push server, and nothing leaves the box
// for one. So the phone schedules its own local notification for each pending
// wait it has seen, at the wait's date, and iOS rings it whether or not the app
// is running. The gap that leaves: a wait set while the phone is not connected
// to that box is unknown here until the next connect.
//
// This file decides WHAT should be scheduled; wait-notifications.ts talks to
// iOS. Pure TS, no React Native imports, so it runs under bun test.
import type { TaskDTO } from "@ateam/protocol";
import { boxKey } from "./boxes";

/** iOS keeps at most 64 pending local notifications per app and drops the rest. */
export const IOS_PENDING_CAP = 64;

/** What travels in the notification, to open the task from a tap. */
export interface ReminderData {
	host: string;
	port: string;
	taskId: string;
	/** The wait's date, so a later reconcile can tell a moved wait from the same one. */
	until: number;
}

export interface Reminder {
	id: string;
	title: string;
	body: string;
	data: ReminderData;
}

export interface ScheduledReminder {
	id: string;
	data: Partial<ReminderData> | null | undefined;
}

type WaitFields = Pick<
	TaskDTO,
	"id" | "name" | "waitingReason" | "waitingUntil" | "waitingFiredAt"
>;

/** Every reminder of one box shares this prefix, so a reconcile can scope to it. */
export function reminderPrefix(box: { host: string; port: string }): string {
	return `wait:${boxKey(box)}:`;
}

export function reminderId(box: { host: string; port: string }, taskId: string): string {
	return `${reminderPrefix(box)}${taskId}`;
}

/** The reminder a task's wait asks for, or null when there is nothing left to ring. */
export function reminderFor(
	box: { host: string; port: string },
	task: WaitFields,
	now: number,
): Reminder | null {
	const until = task.waitingUntil;
	if (until == null || task.waitingFiredAt != null || until <= now) return null;
	return {
		id: reminderId(box, task.id),
		title: task.name,
		// Same words as the Mac's notification (apps/desktop/src/main/wait-notify.ts).
		body: task.waitingReason ? `Check on ${task.waitingReason}` : "A wait on this task is due",
		data: { host: box.host, port: box.port, taskId: task.id, until },
	};
}

export interface ReminderPlan {
	cancel: string[];
	schedule: Reminder[];
}

/**
 * Bring the scheduled reminders in line with what the box says.
 *
 * `tasks` is either the box's whole list (`full`: a reminder for a task not in
 * it is stale) or a single pushed update (only that task is in scope).
 *
 * A wait that FIRED keeps its pending reminder rather than cancelling it: the
 * box stamps it at the same moment the phone's own trigger is due, and if that
 * update won the race a cancel would silence the one notification the wait
 * exists for. Only a wait that was cleared or moved cancels.
 */
export function planReminders(
	box: { host: string; port: string },
	tasks: WaitFields[],
	scheduled: ScheduledReminder[],
	now: number,
	opts: { full: boolean; cap?: number },
): ReminderPlan {
	const prefix = reminderPrefix(box);
	const byId = new Map(tasks.map((t) => [reminderId(box, t.id), t]));
	const mine = scheduled.filter((s) => s.id.startsWith(prefix));
	const cancel: string[] = [];
	const kept = new Set<string>();
	for (const s of mine) {
		const task = byId.get(s.id);
		if (!task) {
			if (opts.full) cancel.push(s.id);
			continue;
		}
		if (task.waitingUntil != null && task.waitingUntil === s.data?.until) kept.add(s.id);
		else cancel.push(s.id);
	}
	const wanted = tasks
		.map((t) => reminderFor(box, t, now))
		.filter((r): r is Reminder => r !== null && !kept.has(r.id))
		.sort((a, b) => a.data.until - b.data.until);
	// What other boxes (and this box's kept ones) already hold counts against the
	// cap; past it the soonest win, and the next reconcile tops up as slots free.
	const cancelled = new Set(cancel);
	const held = scheduled.filter((s) => !cancelled.has(s.id) && !wanted.some((w) => w.id === s.id));
	const room = Math.max(0, (opts.cap ?? IOS_PENDING_CAP) - held.length);
	return { cancel, schedule: wanted.slice(0, room) };
}

/** The reminder a tapped notification carries, if it is one of ours. */
export function reminderTarget(data: unknown): ReminderData | null {
	if (typeof data !== "object" || data === null) return null;
	const d = data as Record<string, unknown>;
	if (typeof d.host !== "string" || typeof d.port !== "string" || typeof d.taskId !== "string") {
		return null;
	}
	return { host: d.host, port: d.port, taskId: d.taskId, until: Number(d.until) || 0 };
}
