import { expect, test } from "bun:test";
import type { KanbanColumn, TaskDTO } from "@ateam/protocol";
import {
	DEFAULT_VIEW,
	filtersSet,
	groupTasks,
	parseView,
	passesFilters,
	spliceOrder,
	toggled,
	updatedBucket,
} from "./sidebar-view";
import type { Alias } from "./unify";

// Local noon, so "today" and "yesterday" never straddle midnight in any zone.
const NOW = new Date(2026, 10, 2, 12, 0, 0).getTime();
const DAY = 86_400_000;

function task(id: string, over: Partial<TaskDTO> = {}): TaskDTO {
	return {
		id,
		projectId: "pLocal",
		name: id,
		column: "todo",
		prState: null,
		lastEventAt: NOW,
		isUnread: false,
		...over,
	} as TaskDTO;
}

const machineOf = (t: TaskDTO): Alias => (t.projectId === "pBox" ? "hetzner" : null);
const ctx = { machineOf, statusLabel: (c: KanbanColumn) => c, now: NOW };
const ids = (list: { id: string }[]) => list.map((t) => t.id);

test("a missing or corrupt stored view reads as the default", () => {
	expect(parseView(null)).toEqual(DEFAULT_VIEW);
	expect(parseView("{not json")).toEqual(DEFAULT_VIEW);
	expect(parseView("42")).toEqual(DEFAULT_VIEW);
});

test("a stored view keeps the values it knows and drops the rest", () => {
	const v = parseView(
		JSON.stringify({
			grouping: "galaxy",
			hiddenStatus: ["merged", "nope", 3],
			hiddenPr: ["none", "draft"],
			hiddenMachines: [null, "hetzner", 7],
			showArchived: "yes",
			collapsed: ["status:review", null],
		}),
	);
	expect(v).toEqual({
		grouping: "none",
		hiddenStatus: ["merged"],
		hiddenPr: ["none"],
		hiddenMachines: [null, "hetzner"],
		showArchived: false,
		collapsed: ["status:review"],
	});
});

test("filters hide by status, by PR state (no PR included) and by machine", () => {
	const view = { ...DEFAULT_VIEW, hiddenStatus: ["merged"] as KanbanColumn[] };
	expect(passesFilters(task("a", { column: "merged" }), view, machineOf)).toBe(false);
	expect(passesFilters(task("a", { column: "review" }), view, machineOf)).toBe(true);

	const noPr = { ...DEFAULT_VIEW, hiddenPr: ["none" as const] };
	expect(passesFilters(task("a"), noPr, machineOf)).toBe(false);
	expect(passesFilters(task("a", { prState: "open" }), noPr, machineOf)).toBe(true);

	const noLocal = { ...DEFAULT_VIEW, hiddenMachines: [null] };
	expect(passesFilters(task("a"), noLocal, machineOf)).toBe(false);
	expect(passesFilters(task("a", { projectId: "pBox" }), noLocal, machineOf)).toBe(true);
});

test("the icon lights only for a filter that can hide something in this project", () => {
	expect(filtersSet(DEFAULT_VIEW, [null])).toBe(false);
	expect(filtersSet({ ...DEFAULT_VIEW, hiddenPr: ["closed"] }, [null])).toBe(true);
	// A box this project isn't on hides nothing here.
	expect(filtersSet({ ...DEFAULT_VIEW, hiddenMachines: ["other-box"] }, [null, "hetzner"])).toBe(
		false,
	);
	expect(filtersSet({ ...DEFAULT_VIEW, hiddenMachines: ["hetzner"] }, [null, "hetzner"])).toBe(
		true,
	);
});

test("toggled adds a missing value and removes a present one", () => {
	expect(toggled(["a"], "b")).toEqual(["a", "b"]);
	expect(toggled(["a", "b"], "a")).toEqual(["b"]);
	expect(toggled<Alias>([null], null)).toEqual([]);
});

test("no grouping is one group with the list as it came", () => {
	const list = [task("b"), task("a")];
	expect(groupTasks(list, "none", ctx)).toEqual([{ key: "all", label: "", tasks: list }]);
});

test("status groups follow the sidebar's status order, skip empty ones and keep the order inside", () => {
	const list = [
		task("t1", { column: "todo" }),
		task("r1", { column: "review" }),
		task("t2", { column: "todo" }),
		task("n1", { column: "needs_attention" }),
	];
	const groups = groupTasks(list, "status", ctx);
	expect(groups.map((g) => g.key)).toEqual([
		"status:review",
		"status:needs_attention",
		"status:todo",
	]);
	expect(ids(groups[2].tasks)).toEqual(["t1", "t2"]);
});

test("machine groups put this Mac first, then boxes by name", () => {
	const machineOf3 = (t: TaskDTO): Alias =>
		t.projectId === "pBox" ? "zeta" : t.projectId === "pBox2" ? "alpha" : null;
	const list = [task("z", { projectId: "pBox" }), task("a", { projectId: "pBox2" }), task("l")];
	const groups = groupTasks(list, "machine", { ...ctx, machineOf: machineOf3 });
	expect(groups.map((g) => [g.key, g.label])).toEqual([
		["machine:", "Local"],
		["machine:alpha", "alpha"],
		["machine:zeta", "zeta"],
	]);
});

test("updated groups go by local calendar day, and no activity is Older", () => {
	expect(updatedBucket(NOW - 60_000, NOW)).toBe("today");
	expect(updatedBucket(NOW - DAY, NOW)).toBe("yesterday");
	expect(updatedBucket(NOW - 6 * DAY, NOW)).toBe("week");
	expect(updatedBucket(NOW - 7 * DAY, NOW)).toBe("older");
	expect(updatedBucket(null, NOW)).toBe("older");

	const list = [
		task("old", { lastEventAt: null }),
		task("now"),
		task("y", { lastEventAt: NOW - DAY }),
	];
	expect(groupTasks(list, "updated", ctx).map((g) => [g.label, ids(g.tasks)])).toEqual([
		["Today", ["now"]],
		["Yesterday", ["y"]],
		["Older", ["old"]],
	]);
});

test("a drag inside one group trades only that group's slots", () => {
	// a, c in one group; b, d elsewhere (another group, or hidden by a filter).
	expect(spliceOrder(["a", "b", "c", "d"], ["c", "a"])).toEqual(["c", "b", "a", "d"]);
	// The whole list as the group is a plain reorder.
	expect(spliceOrder(["a", "b", "c"], ["c", "a", "b"])).toEqual(["c", "a", "b"]);
});
