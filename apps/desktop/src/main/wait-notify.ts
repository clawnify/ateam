// macOS notification when a task's wait comes due (see waits.ts in the server).
//
// The engine already does the board's half: it files the card in Needs You and
// stamps `waitingFiredAt`. This is the half that reaches you when you are not
// looking at the board. It watches the taskUpdated stream every engine pushes
// (the local one and each connected box), so it needs no channel of its own.
//
// Once per firing: the key is (task, waitingFiredAt), and a re-set wait gets a
// new stamp. Only a FRESH firing: the same task keeps arriving with the old
// stamp on every later update (a git refresh, a rename), and after a restart
// this process has forgotten what it already showed, so anything older than a
// few minutes is the card's job, not a notification's.
import type { TaskDTO } from "@ateam/protocol";
import { Notification } from "electron";

/** How late a firing may still be announced: covers boot and clock skew. */
export const FRESH_MS = 10 * 60_000;

export interface WaitNotice {
	key: string;
	title: string;
	body: string;
}

/** The notice to show for this update, or null. Pure; `shown` is read, not written. */
export function waitNotice(
	task: TaskDTO,
	shown: ReadonlySet<string>,
	now: number,
): WaitNotice | null {
	const firedAt = task.waitingFiredAt;
	if (firedAt == null) return null;
	if (now - firedAt > FRESH_MS) return null;
	const key = `${task.id}:${firedAt}`;
	if (shown.has(key)) return null;
	return {
		key,
		title: task.name,
		body: task.waitingReason ? `Check on ${task.waitingReason}` : "A wait on this task is due",
	};
}

/**
 * Wire it: returns the function to call with every taskUpdated payload.
 * `onClick` brings a window forward and opens the task there.
 */
export function createWaitNotifier(onClick: (task: TaskDTO) => void): (task: TaskDTO) => void {
	const shown = new Set<string>();
	// Electron drops a notification's handlers once it is garbage collected,
	// which turns a click into a no-op; hold each one until it is done with.
	const live = new Set<Notification>();
	return (task) => {
		const notice = waitNotice(task, shown, Date.now());
		if (!notice || !Notification.isSupported()) return;
		shown.add(notice.key);
		const n = new Notification({ title: notice.title, body: notice.body });
		live.add(n);
		n.on("click", () => {
			live.delete(n);
			onClick(task);
		});
		n.on("close", () => live.delete(n));
		n.show();
	};
}
