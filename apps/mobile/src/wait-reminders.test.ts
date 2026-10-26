// Which local notifications the phone keeps for task waits.
import { describe, expect, test } from "bun:test";
import {
	planReminders,
	reminderFor,
	reminderId,
	reminderTarget,
	type ScheduledReminder,
} from "./wait-reminders";

const NOW = 1_800_000_000_000;
const box = { host: "100.72.63.61", port: "8787" };
const other = { host: "100.94.46.10", port: "8787" };

function task(id: string, until: number | null, firedAt: number | null = null) {
	return {
		id,
		name: `task ${id}`,
		waitingReason: until == null ? null : "Pedro's nightly run",
		waitingUntil: until,
		waitingFiredAt: firedAt,
	};
}

function held(b: typeof box, id: string, until: number): ScheduledReminder {
	return { id: reminderId(b, id), data: { ...b, taskId: id, until } };
}

describe("reminderFor", () => {
	test("a pending wait rings at its date, saying what to check", () => {
		expect(reminderFor(box, task("a", NOW + 60_000), NOW)).toEqual({
			id: "wait:100.72.63.61:8787:a",
			title: "task a",
			body: "Check on Pedro's nightly run",
			data: { host: box.host, port: box.port, taskId: "a", until: NOW + 60_000 },
		});
	});

	test("nothing for no wait, a fired wait, or a date already past", () => {
		expect(reminderFor(box, task("a", null), NOW)).toBeNull();
		expect(reminderFor(box, task("a", NOW + 60_000, NOW), NOW)).toBeNull();
		expect(reminderFor(box, task("a", NOW - 1), NOW)).toBeNull();
	});
});

describe("planReminders", () => {
	test("schedules new waits, soonest first", () => {
		const plan = planReminders(box, [task("a", NOW + 9000), task("b", NOW + 1000)], [], NOW, {
			full: true,
		});
		expect(plan.cancel).toEqual([]);
		expect(plan.schedule.map((r) => r.data.taskId)).toEqual(["b", "a"]);
	});

	test("leaves an unchanged wait alone and reschedules a moved one", () => {
		const plan = planReminders(
			box,
			[task("a", NOW + 1000), task("b", NOW + 5000)],
			[held(box, "a", NOW + 1000), held(box, "b", NOW + 2000)],
			NOW,
			{ full: true },
		);
		expect(plan.cancel).toEqual([reminderId(box, "b")]);
		expect(plan.schedule.map((r) => [r.data.taskId, r.data.until])).toEqual([["b", NOW + 5000]]);
	});

	test("a cleared wait cancels its reminder", () => {
		const plan = planReminders(box, [task("a", null)], [held(box, "a", NOW + 1000)], NOW, {
			full: false,
		});
		expect(plan).toEqual({ cancel: [reminderId(box, "a")], schedule: [] });
	});

	// The box stamps the wait as fired at the moment the phone's trigger is due.
	// If that update lands first, cancelling would silence the reminder.
	test("a wait that just fired keeps its pending reminder", () => {
		const plan = planReminders(box, [task("a", NOW, NOW)], [held(box, "a", NOW)], NOW, {
			full: false,
		});
		expect(plan).toEqual({ cancel: [], schedule: [] });
	});

	test("a full list drops reminders for tasks that are gone; a single update does not", () => {
		const scheduled = [held(box, "gone", NOW + 1000)];
		expect(planReminders(box, [], scheduled, NOW, { full: true }).cancel).toEqual([
			reminderId(box, "gone"),
		]);
		expect(planReminders(box, [task("a", null)], scheduled, NOW, { full: false }).cancel).toEqual(
			[],
		);
	});

	test("never touches another box's reminders", () => {
		const plan = planReminders(box, [], [held(other, "x", NOW + 1000)], NOW, { full: true });
		expect(plan.cancel).toEqual([]);
	});

	test("stays under the iOS cap, counting what other boxes hold", () => {
		const plan = planReminders(
			box,
			[task("a", NOW + 3000), task("b", NOW + 1000), task("c", NOW + 2000)],
			[held(other, "x", NOW + 1000)],
			NOW,
			{ full: true, cap: 3 },
		);
		expect(plan.schedule.map((r) => r.data.taskId)).toEqual(["b", "c"]);
	});
});

describe("reminderTarget", () => {
	test("reads our data back from a tapped notification", () => {
		expect(reminderTarget({ host: "h", port: "8787", taskId: "t", until: 5 })).toEqual({
			host: "h",
			port: "8787",
			taskId: "t",
			until: 5,
		});
	});

	test("ignores anything else", () => {
		expect(reminderTarget(null)).toBeNull();
		expect(reminderTarget({ host: "h" })).toBeNull();
	});
});
