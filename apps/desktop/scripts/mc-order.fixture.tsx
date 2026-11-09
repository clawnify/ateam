import type { AteamApi, TaskDTO } from "@ateam/protocol";
import { type SetStateAction, useState } from "react";
import { createRoot } from "react-dom/client";
import { MissionControl } from "../src/renderer/src/App";
import { type McPins, readMcPins } from "../src/renderer/src/mc-order";
import { TASK_DRAG_MIME } from "../src/renderer/src/task-drag";
import "@xterm/xterm/css/xterm.css";

const delay = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
const initial = Array.from(
	{ length: 8 },
	(_, i) =>
		({
			id: String.fromCharCode(97 + i),
			name: String.fromCharCode(97 + i),
			column: "running",
			agentStatus: "running",
			lastEventAt: 10 + i,
		}) as TaskDTO,
);
let updateTasks: (tasks: TaskDTO[]) => void;
let refresh: () => void;
let remount: () => void;
let setLayout: (layout: "auto" | "grid") => void;
let latestPins: McPins = {};
let fetches = 0;
const taskListeners = new Set<() => void>();
const exitListeners = new Set<() => void>();
let holdFetch = false;
let releaseFetch: (() => void) | undefined;
let awake = false;
let finishWake: (() => void) | undefined;
const sessions = (id: string) => [
	{ terminalId: `term-${id}`, taskId: id, agentId: "claude", status: "running" },
];
window.ateam = {
	pty: {
		listForTask: async (id: string) => {
			fetches++;
			if (holdFetch && id === "a")
				await new Promise<void>((resolve) => {
					releaseFetch = resolve;
				});
			return id === "z" && !awake ? [] : sessions(id);
		},
		onExit: (fn: () => void) => {
			exitListeners.add(fn);
			return () => exitListeners.delete(fn);
		},
		onData: () => () => {},
		snapshot: async () => ({ data: "test terminal\r\n", seq: 0 }),
		write() {},
		resize() {},
	},
	events: {
		onTaskUpdated: (fn: () => void) => {
			taskListeners.add(fn);
			return () => taskListeners.delete(fn);
		},
	},
	git: { diff: async () => ({ files: [], additions: 0, deletions: 0 }) },
	settings: { get: async () => ({ settings: { client: { pinnedSkills: [] } } }) },
	skills: { list: async () => [] },
} as unknown as AteamApi;

function Harness() {
	const [tasks, setTasks] = useState(initial);
	const [pins, setPins] = useState<McPins>(() => readMcPins("test.pins"));
	const [syncSeq, setSync] = useState(0);
	const [generation, setGeneration] = useState(0);
	const [layout, chooseLayout] = useState<"auto" | "grid">("auto");
	const [shown, setShown] = useState({});
	const [highlight, setHighlight] = useState<string | null>(null);
	updateTasks = setTasks;
	setLayout = chooseLayout;
	const savePins = (update: SetStateAction<McPins>) => {
		const next = typeof update === "function" ? update(readMcPins("test.pins")) : update;
		latestPins = next;
		setPins(next);
		localStorage.setItem("test.pins", JSON.stringify(next));
	};
	refresh = () => {
		savePins({});
		setSync((s) => s + 1);
	};
	remount = () => {
		setPins(readMcPins("test.pins"));
		setGeneration((g) => g + 1);
	};
	return (
		<MissionControl
			key={generation}
			mode="tasks"
			shownByTask={shown}
			setShownByTask={setShown}
			tasks={tasks}
			agents={[]}
			order={initial.map((t) => t.id)}
			pins={pins}
			onPinsChange={savePins}
			layout={layout}
			syncSeq={syncSeq}
			onExpand={() => {}}
			highlightId={highlight}
			onHighlight={setHighlight}
			jump={null}
			onJumpMissing={() => {}}
			onReorder={() => {}}
			onWake={() =>
				new Promise<boolean>((resolve) => {
					finishWake = () => {
						awake = true;
						resolve(true);
						for (const fn of taskListeners) fn();
					};
				})
			}
		/>
	);
}

function assert(ok: boolean, label: string) {
	if (!ok) throw new Error(label);
}
const order = () =>
	[...document.querySelectorAll(".bar-name")].map((el) => el.textContent).join("");
function element<T extends HTMLElement = HTMLElement>(
	selector: string,
	parent: ParentNode = document,
): T {
	const found = parent.querySelector<T>(selector);
	if (!found) throw new Error(`Missing fixture element: ${selector}`);
	return found;
}
function tile(id: string) {
	const found = [...document.querySelectorAll<HTMLElement>(".tile")].find(
		(el) => el.querySelector(".bar-name")?.textContent === id,
	);
	if (!found) throw new Error(`Missing fixture tile: ${id}`);
	return found;
}
// Select a tile the way a click does: the pointerdown highlights it (an
// offscreen window fires no focus events), then its terminal takes the keys.
function select(id: string): HTMLTextAreaElement {
	tile(id).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
	const textarea = element<HTMLTextAreaElement>("textarea", tile(id));
	textarea.focus();
	return textarea;
}
async function drop(from: string, onto: string, during?: () => void | Promise<void>) {
	const transfer = new DataTransfer();
	const held = order();
	// Use the real dragstart handler to set its private dataTransfer type.
	element(".bar", tile(from)).dispatchEvent(
		new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }),
	);
	await delay(20);
	if (during) {
		await during();
		await delay();
		assert(order() === held, "live activity moved a drop target during a drag");
	}
	tile(onto).dispatchEvent(
		new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
	);
	await delay();
}

async function run() {
	const root = createRoot(element("#root"));
	root.render(<Harness />);
	await delay(350);
	assert(order() === "hgfedc", `initial priority: ${order()}`);
	const grid = element(".mc");
	const shape = grid.style.cssText;
	const textarea = element<HTMLTextAreaElement>("textarea", tile("h"));
	textarea.focus();
	const before = fetches;
	// A visible task needing attention has no reason to move its neighbours.
	let tasks = initial.map((t) =>
		t.id === "d" ? { ...t, column: "needs_attention" as const, lastEventAt: 100 } : t,
	);
	updateTasks(tasks);
	await delay(5200);
	assert(order() === "hgfedc", "same-page priority shuffled visible terminals");
	assert(fetches === before, "priority must not refetch sessions");
	assert(document.activeElement === textarea, "same-page activity moved focus");
	assert(
		tile("h").querySelector("textarea") === textarea,
		"same-page activity remounted a terminal",
	);
	assert(grid.style.cssText === shape, "activity changed the layout shape");

	// Two off-page promotions restart the timer. Metadata-only changes do not.
	// The selected terminal (e) stays; the lowest of the rest make room.
	const selected = select("e");
	tasks = tasks.map((t) =>
		t.id === "a" ? { ...t, column: "needs_attention" as const, lastEventAt: 200 } : t,
	);
	updateTasks(tasks);
	await delay(2600);
	tasks = tasks.map((t) =>
		t.id === "b" ? { ...t, column: "needs_attention" as const, lastEventAt: 300 } : t,
	);
	updateTasks(tasks);
	await delay(2600);
	assert(order() === "hgfedc", "a superseded priority timer was not cancelled");
	updateTasks(tasks.map((t) => ({ ...t, isUnread: true })));
	await delay(2700);
	assert(order() === "hgbeda", `cross-page replacements moved shared terminals: ${order()}`);
	assert(document.activeElement === selected, "a promotion took the selected terminal away");
	assert(
		tile("h").querySelector("textarea") === textarea,
		"cross-page replacement remounted a shared terminal",
	);

	// A same-page-only change after this promotion must also remain stable.
	tasks = tasks.map((t) =>
		t.id === "h" ? { ...t, column: "needs_attention" as const, lastEventAt: 400 } : t,
	);
	updateTasks(tasks);
	await delay(5200);
	assert(order() === "hgbeda", "same-page priority shuffled terminals after a promotion");

	// Refresh bypasses both debounce and same-page stability.
	updateTasks(initial);
	await delay();
	assert(order() === "hgbeda", "priority changed before Refresh");
	refresh();
	await delay();
	assert(order() === "hgfedc", "Refresh did not immediately apply the full priority order");
	await delay(5200);
	assert(order() === "hgfedc", "a stale timer changed the order after Refresh");

	// Fresh activity still wins when the session fetch is slow or stale.
	holdFetch = true;
	for (const fn of taskListeners) fn();
	tasks = initial.map((t) =>
		t.id === "a" ? { ...t, column: "needs_attention" as const, lastEventAt: 200 } : t,
	);
	updateTasks(tasks);
	await delay(5200);
	assert(order() === "hgfeda", "slow fetch blocked promotion or shuffled shared tiles");
	holdFetch = false;
	releaseFetch?.();
	await delay();
	assert(order() === "hgfeda", "stale session fetch restored an old task status");
	updateTasks(initial);
	await delay();
	refresh();
	await delay();

	// A manual pin is immediate, even when a promotion settles during the drag.
	await drop("f", "h", async () => {
		updateTasks(tasks);
		await delay(5200);
	});
	assert(latestPins.f === 0, "drag did not pin the target slot immediately");
	assert(order() === "fhgeda", `pin or queued promotion lost its position: ${order()}`);
	remount();
	await delay(200);
	assert(order().startsWith("f"), "pin did not survive remount");
	refresh();
	await delay();
	assert(order() === "ahgfed", `Refresh must release pins and fully sort: ${order()}`);
	assert(Object.keys(latestPins).length === 0, "Refresh did not clear persisted pins");

	// An off-page arrival replaces only the outgoing slot and never takes focus:
	// not the selected terminal's (d), the lowest of the rest (e).
	const working = select("d");
	tasks = tasks.map((t) =>
		t.id === "b" ? { ...t, lastEventAt: 300, column: "needs_attention" as const } : t,
	);
	updateTasks(tasks);
	await delay(5200);
	assert(order() === "ahgfbd", `off-page promotion moved shared tiles: ${order()}`);
	assert(document.activeElement === working, "an arrival took the selected terminal away");

	// Refresh cancels the placement and focus of a task still waking.
	tasks = [
		...tasks,
		{ ...initial[0], id: "z", name: "z", column: "running", lastEventAt: 500 } as TaskDTO,
	];
	updateTasks(tasks);
	await delay();
	const pill = new DataTransfer();
	pill.setData(TASK_DRAG_MIME, "z");
	tile("d").dispatchEvent(
		new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: pill }),
	);
	await delay();
	assert(latestPins.z === 5, "waking task did not reserve its drop slot");
	refresh();
	await delay();
	finishWake?.();
	await delay(5200);
	assert(order() === "bahgfz", `late wake restored stale placement: ${order()}`);
	assert(Object.keys(latestPins).length === 0, "late wake restored cleared pins");
	assert(!document.activeElement?.closest(".tile"), "late wake restored cleared focus");

	// Working on page 2: the selected terminal turning newest stays on that page
	// instead of jumping to page 1, and page 1 stays as it was.
	const flip = (key: "ArrowDown" | "ArrowUp") =>
		window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true }));
	const firstPage = order();
	flip("ArrowDown");
	await delay(600);
	const secondPage = order();
	assert(secondPage.length > 0 && !secondPage.includes("b"), `no second page: ${secondPage}`);
	const last = secondPage[secondPage.length - 1];
	select(last);
	tasks = tasks.map((t) => (t.id === last ? { ...t, lastEventAt: 700 } : t));
	updateTasks(tasks);
	await delay(5200);
	assert(order() === secondPage, `the selected terminal left its page: ${order()}`);
	flip("ArrowUp");
	await delay(600);
	assert(order() === firstPage, `page 1 took the selected terminal: ${order()}`);

	setLayout("grid");
	await delay();
	const fixed = order();
	updateTasks(tasks.map((t) => (t.id === "g" ? { ...t, lastEventAt: 600 } : t)));
	await delay();
	assert(order() === fixed, "fixed layout began automatically reordering");
	updateTasks(tasks.filter((t) => t.id !== "a"));
	await delay();
	assert(!order().includes("a"), "deleted task retained a tile");
	root.unmount();
	return "PASS: same-page stability, minimal cross-page replacements, the selected terminal keeps its page, debounce reset, immediate Refresh, pins, stale fetches, fixed layout and focus safety";
}
(window as unknown as { runMcOrderTests: typeof run }).runMcOrderTests = run;
