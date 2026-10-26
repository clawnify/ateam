// The iOS half of task-wait reminders: schedules and cancels the local
// notifications that src/wait-reminders.ts plans, and reports taps.
import type { TaskDTO } from "@ateam/protocol";
import * as Notifications from "expo-notifications";
import { planReminders, type ReminderData, reminderTarget } from "./wait-reminders";

// With the app open a reminder still shows as a banner: the board may be on
// another project, or another box, than the task that came due.
Notifications.setNotificationHandler({
	handleNotification: async () => ({
		shouldShowBanner: true,
		shouldShowList: true,
		shouldPlaySound: true,
		shouldSetBadge: false,
	}),
});

// One sync at a time: each reads what is scheduled and acts on it, so two
// interleaved (a full refresh and a pushed update) could double-schedule.
let queue: Promise<void> = Promise.resolve();

/**
 * Match the scheduled reminders to `tasks` from the box at `box`. `full` means
 * `tasks` is the box's whole list (a refresh), so reminders for tasks missing
 * from it are dropped; otherwise it is one pushed update.
 */
export function syncReminders(
	box: { host: string; port: string },
	tasks: TaskDTO[],
	full: boolean,
): void {
	queue = queue.then(() => sync(box, tasks, full)).catch(() => {});
}

async function sync(box: { host: string; port: string }, tasks: TaskDTO[], full: boolean) {
	const scheduled = (await Notifications.getAllScheduledNotificationsAsync()).map((r) => ({
		id: r.identifier,
		data: r.content.data as Partial<ReminderData> | null,
	}));
	const plan = planReminders(box, tasks, scheduled, Date.now(), { full });
	for (const id of plan.cancel) await Notifications.cancelScheduledNotificationAsync(id);
	if (plan.schedule.length === 0 || !(await allowed())) return;
	for (const r of plan.schedule) {
		await Notifications.scheduleNotificationAsync({
			identifier: r.id,
			content: { title: r.title, body: r.body, data: { ...r.data }, sound: true },
			trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: r.data.until },
		});
	}
}

// Asked the first time there is a reminder to schedule, not at launch: that is
// the moment the request makes sense, and someone who never sets a wait is
// never asked.
async function allowed(): Promise<boolean> {
	const now = await Notifications.getPermissionsAsync();
	if (now.granted || !now.canAskAgain) return now.granted;
	const asked = await Notifications.requestPermissionsAsync({
		ios: { allowAlert: true, allowSound: true, allowBadge: false },
	});
	return asked.granted;
}

/**
 * Call `onTap` for every reminder the user taps, including the one that
 * launched the app. Returns the unsubscribe.
 */
export function onReminderTap(onTap: (target: ReminderData) => void): () => void {
	// A cold launch can report the same tap through both routes below.
	let last: string | null = null;
	const handle = (res: Notifications.NotificationResponse | null) => {
		if (!res) return;
		const key = `${res.notification.request.identifier}:${res.notification.date}`;
		const target = reminderTarget(res.notification.request.content.data);
		if (!target || key === last) return;
		last = key;
		// Otherwise the next launch would read the same tap again.
		void Notifications.clearLastNotificationResponseAsync();
		onTap(target);
	};
	void Notifications.getLastNotificationResponseAsync().then(handle);
	const sub = Notifications.addNotificationResponseReceivedListener(handle);
	return () => sub.remove();
}
