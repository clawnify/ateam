// The sidebar TASKS list's view: how it is grouped and what the filters hide,
// set from the view menu on the TASKS header (components/SidebarViewMenu.tsx).
// Ordering is not here: it predates the menu and keeps its own stored key,
// `ateam.taskSort`, so the order someone already picked carries over.
//
// The view only ever changes the sidebar. Mission Control keeps its own tile
// order and takes the sidebar's only when its Sync button is pressed.
//
// Pure + unit-tested (see sidebar-view.test.ts).
import {
	type Alias,
	aliasLabel,
	type KanbanColumn,
	type PrState,
	type TaskDTO,
} from "@ateam/protocol";

/** The list's order, inside each group when it is grouped. */
export type TaskSortMode = "next" | "status" | "updated" | "custom";
export type TaskGrouping = "none" | "status" | "machine" | "updated" | "project";
/** A task's PR filter value: its PR's state, or "none" when it has no PR. */
export type PrKey = PrState | "none";

export interface SidebarView {
	grouping: TaskGrouping;
	/** The grouping while the sidebar lists every project. It is its own, so
	 *  All opens grouped by project and a pick there leaves one project's list
	 *  as it was. The filters are shared. */
	allGrouping: TaskGrouping;
	/** Unticked filter values. Stored as what is hidden rather than what is
	 *  shown, so a value that appears later (a box added next week) shows. */
	hiddenStatus: KanbanColumn[];
	hiddenPr: PrKey[];
	hiddenMachines: Alias[];
	/** Archived tasks join the list (they are off it otherwise). */
	showArchived: boolean;
	/** Folded group headers, by group key (see groupTasks). */
	collapsed: string[];
}

export const DEFAULT_VIEW: SidebarView = {
	grouping: "none",
	allGrouping: "project",
	hiddenStatus: [],
	hiddenPr: [],
	hiddenMachines: [],
	showArchived: false,
	collapsed: [],
};

/** Status order: what needs the user's eyes first. The sidebar's "Status"
 *  ordering and its Status groups both use it. */
export const STATUS_RANK: Record<KanbanColumn, number> = {
	review: 0,
	needs_attention: 1,
	running: 2,
	todo: 3,
	merged: 4,
};
const STATUS_ORDER = (Object.keys(STATUS_RANK) as KanbanColumn[]).sort(
	(a, b) => STATUS_RANK[a] - STATUS_RANK[b],
);

const GROUPINGS: readonly TaskGrouping[] = ["none", "status", "machine", "updated", "project"];
export const PR_KEYS: readonly PrKey[] = ["none", "open", "merged", "closed"];

/**
 * The stored view, or the default for anything missing or malformed. It comes
 * from localStorage, which an older or newer build may have written, so every
 * field is checked rather than trusted.
 */
export function parseView(raw: string | null): SidebarView {
	let v: unknown = null;
	try {
		v = raw ? JSON.parse(raw) : null;
	} catch {
		v = null;
	}
	if (!v || typeof v !== "object") return DEFAULT_VIEW;
	const o = v as Record<string, unknown>;
	const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
	const grouping = (g: unknown, fallback: TaskGrouping): TaskGrouping =>
		GROUPINGS.includes(g as TaskGrouping) ? (g as TaskGrouping) : fallback;
	return {
		grouping: grouping(o.grouping, "none"),
		allGrouping: grouping(o.allGrouping, "project"),
		hiddenStatus: list(o.hiddenStatus).filter(
			(s): s is KanbanColumn => typeof s === "string" && s in STATUS_RANK,
		),
		hiddenPr: list(o.hiddenPr).filter((s): s is PrKey => PR_KEYS.includes(s as PrKey)),
		hiddenMachines: list(o.hiddenMachines).filter(
			(m): m is Alias => m === null || typeof m === "string",
		),
		showArchived: o.showArchived === true,
		collapsed: list(o.collapsed).filter((k): k is string => typeof k === "string"),
	};
}

/** The view the list uses: under All, its own grouping in place of one
 *  project's. */
export function scopedView(view: SidebarView, all: boolean): SidebarView {
	return all ? { ...view, grouping: view.allGrouping } : view;
}

/** A change made from the menu (which shows the scoped view), written back so
 *  the grouping lands on the scope it was picked in and the other keeps its own. */
export function unscopedView(view: SidebarView, next: SidebarView, all: boolean): SidebarView {
	return all
		? { ...next, grouping: view.grouping, allGrouping: next.grouping }
		: { ...next, allGrouping: view.allGrouping };
}

/** Whether a task passes the view's filters. */
export function passesFilters(
	t: TaskDTO,
	view: SidebarView,
	machineOf: (t: TaskDTO) => Alias,
): boolean {
	return (
		!view.hiddenStatus.includes(t.column) &&
		!view.hiddenPr.includes(t.prState ?? "none") &&
		!view.hiddenMachines.includes(machineOf(t))
	);
}

/**
 * Whether any filter is set, which lights the menu's icon. A hidden box this
 * project isn't on doesn't count: that filter can't hide anything here.
 */
export function filtersSet(view: SidebarView, machines: Alias[]): boolean {
	return (
		view.hiddenStatus.length > 0 ||
		view.hiddenPr.length > 0 ||
		machines.some((m) => view.hiddenMachines.includes(m))
	);
}

/** Toggle one value in a list (a filter's ticked state, a folded group). */
export function toggled<T>(list: T[], value: T): T[] {
	return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export interface TaskGroup {
	/** Stable across reloads, so a folded group stays folded ("status:review"). */
	key: string;
	label: string;
	tasks: TaskDTO[];
}

type UpdatedBucket = "today" | "yesterday" | "week" | "older";
const UPDATED_LABEL: Record<UpdatedBucket, string> = {
	today: "Today",
	yesterday: "Yesterday",
	week: "Past week",
	older: "Older",
};

/** Which "Updated" group a last-activity time falls in, by local calendar day:
 *  the past week is the five days before yesterday. No activity is Older. */
export function updatedBucket(at: number | null | undefined, now: number): UpdatedBucket {
	if (at == null) return "older";
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	const daysBack = (n: number) => {
		const d = new Date(today);
		d.setDate(d.getDate() - n);
		return d.getTime();
	};
	if (at >= today.getTime()) return "today";
	if (at >= daysBack(1)) return "yesterday";
	if (at >= daysBack(6)) return "week";
	return "older";
}

/**
 * Split the list into groups, keeping each task's place in the list's order
 * (so the ordering applies inside every group). Empty groups are left out.
 * With no grouping it is one group holding everything.
 */
export function groupTasks(
	tasks: TaskDTO[],
	grouping: TaskGrouping,
	ctx: {
		machineOf: (t: TaskDTO) => Alias;
		statusLabel: (c: KanbanColumn) => string;
		now: number;
		/** The repo card a task is in (key and name), for the Project grouping. */
		projectOf?: (t: TaskDTO) => { key: string; name: string };
	},
): TaskGroup[] {
	const by = <K>(keyOf: (t: TaskDTO) => K, order: K[], prefix: string, label: (k: K) => string) =>
		order.flatMap((k) => {
			const inGroup = tasks.filter((t) => keyOf(t) === k);
			return inGroup.length > 0
				? [{ key: `${prefix}:${k ?? ""}`, label: label(k), tasks: inGroup }]
				: [];
		});
	switch (grouping) {
		case "status":
			return by((t) => t.column, STATUS_ORDER, "status", ctx.statusLabel);
		case "machine": {
			// This Mac first, then each box by name: the order the Projects
			// section lists a repo's machines in.
			const machines = [...new Set(tasks.map(ctx.machineOf))].sort((a, b) =>
				a === null ? -1 : b === null ? 1 : a.localeCompare(b),
			);
			return by(ctx.machineOf, machines, "machine", aliasLabel);
		}
		case "project": {
			const projectOf = ctx.projectOf;
			if (!projectOf) break;
			// By name, like the machines: a group's place never depends on its tasks.
			const names = new Map(tasks.map((t) => [projectOf(t).key, projectOf(t).name]));
			const keys = [...names.keys()].sort((a, b) =>
				(names.get(a) ?? "").localeCompare(names.get(b) ?? ""),
			);
			return by(
				(t) => projectOf(t).key,
				keys,
				"project",
				(k) => names.get(k) ?? k,
			);
		}
		case "updated":
			return by(
				(t) => updatedBucket(t.lastEventAt, ctx.now),
				Object.keys(UPDATED_LABEL) as UpdatedBucket[],
				"updated",
				(b) => UPDATED_LABEL[b],
			);
	}
	return [{ key: "all", label: "", tasks }];
}

/**
 * A custom-order drag inside one group, written back into the whole order: the
 * dragged group's tasks trade places among the slots they already held, and
 * every other task (other groups, ones a filter hides) keeps its slot.
 * `reordered` must be the same ids as the group, in their new order.
 */
export function spliceOrder(full: string[], reordered: string[]): string[] {
	const moved = new Set(reordered);
	let k = 0;
	return full.map((id) => (moved.has(id) ? (reordered[k++] ?? id) : id));
}
