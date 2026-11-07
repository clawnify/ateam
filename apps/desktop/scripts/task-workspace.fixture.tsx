import type { AteamApi, SessionDTO, TaskDTO, TaskPageDTO } from "@ateam/protocol";
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { TaskPanel } from "../src/renderer/src/App";
import "../src/renderer/src/index.css";
import "@xterm/xterm/css/xterm.css";

const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
const pages: TaskPageDTO[] = [
	{ id: "research", title: "Research", at: 1 },
	{ id: "plan", title: "Plan", at: 2 },
	{ id: "decision", title: "Decision", at: 3, fromQuestion: true },
];
const initial = {
	id: "task",
	name: "Task workspace",
	column: "review",
	agentId: "shell",
	page: pages[1],
} as TaskDTO;
let live = ["c", "b", "a"];
const exits = new Set<() => void>();
const snapshots = new Map<string, number>();
let kills = 0;
let errors: unknown[] = [];
let changeTask: (task: TaskDTO) => void;
let changeMode: (mode: "side" | "full") => void;

window.ateam = {
	pty: {
		listForTask: async (id: string) =>
			id === "task"
				? (live.map((terminalId) => ({
						terminalId,
						taskId: id,
						agentId: "shell",
						status: "idle",
					})) as SessionDTO[])
				: [],
		listRestorable: async () => [],
		onExit: (fn: () => void) => {
			exits.add(fn);
			return () => exits.delete(fn);
		},
		onData: () => () => {},
		snapshot: async (id: string) => {
			snapshots.set(id, (snapshots.get(id) ?? 0) + 1);
			return { data: `${id}\r\n`, seq: 0 };
		},
		kill: async () => {
			kills++;
		},
		write() {},
		resize() {},
	},
	tasks: {
		pages: async (id: string) => (id === "task" ? [...pages] : []),
		markRead: async () => {},
		answerQuestion: async () => {},
	},
	events: { onTaskUpdated: () => () => {} },
	git: { diff: async () => ({ files: [], additions: 0, deletions: 0 }), status: async () => ({}) },
	settings: { get: async () => ({ settings: { client: { pinnedSkills: [] } } }) },
	skills: { list: async () => [] },
	utils: {},
} as unknown as AteamApi;

function Harness() {
	const [task, setTask] = useState(initial);
	const [terminal, setTerminal] = useState<string | null>("a");
	const [mode, setMode] = useState<"side" | "full">("full");
	changeTask = setTask;
	changeMode = setMode;
	const run = useCallback(async (fn: () => Promise<void>) => {
		try {
			await fn();
		} catch (e) {
			errors.push(e);
		}
	}, []);
	return (
		<div style={{ width: mode === "full" ? 1200 : 480, height: 760, display: "flex" }}>
			<TaskPanel
				key={mode}
				task={task}
				agents={[]}
				envAgents={{}}
				alias={null}
				onInstallAgent={async () => ({})}
				onOpenProposal={() => {}}
				onWait={() => {}}
				mode={mode}
				onSetMode={setMode}
				terminalId={terminal}
				setTerminal={setTerminal}
				run={run}
				ask={async () => null}
				confirm={async () => false}
				onDelete={() => {}}
				onClose={() => {}}
			/>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(<Harness />);
const tab = (title: string) =>
	[...document.querySelectorAll<HTMLButtonElement>(".sess-tab-name")].find(
		(b) => b.textContent === title,
	);
const terminal = (id: string) => document.querySelector<HTMLElement>(`[data-terminal-id="${id}"]`);
const input = (id: string) => terminal(id)?.querySelector<HTMLTextAreaElement>("textarea");
const focused = () =>
	document.activeElement?.closest<HTMLElement>("[data-terminal-id]")?.dataset.terminalId;

Object.assign(window, {
	runTaskWorkspaceTests: async () => {
		const checks: string[] = [];
		const check = (ok: unknown, name: string) => {
			if (!ok) throw new Error(name);
			checks.push(name);
		};
		await pause();
		const firstSnapshot = snapshots.get("a");
		tab("Plan")!.click();
		await pause();
		check(
			document.querySelector(".page-pane") && terminal("a"),
			"doc opens beside the last session",
		);
		check(
			snapshots.get("a") === firstSnapshot,
			"opening a doc preserves the mounted primary terminal",
		);
		tab("Research")!.click();
		await pause();
		check(
			document.querySelector<HTMLIFrameElement>(".page-pane iframe")?.src.includes("research"),
			"older artifacts remain addressable",
		);
		check(!!tab("Plan"), "switching docs retains the other artifact tab");

		tab("Shell 2")!.click();
		await pause();
		check(terminal("b") && terminal("a"), "companion terminal keeps the primary mounted");
		input("a")!.focus();
		window.dispatchEvent(new CustomEvent("ateam:focus-terminal", { detail: "a" }));
		check(focused() === "a", "a focus request reaches only its intended terminal");
		document.querySelector<HTMLButtonElement>('[aria-label="Show beside the board"]')!.click();
		await pause();
		document.querySelector<HTMLButtonElement>('[aria-label="Expand to full width"]')!.click();
		await pause();
		check(focused() === "a", "layout remounts restore focus to the primary session");
		input("b")!.focus();
		live = ["c", "b"];
		for (const fn of exits) fn();
		await pause();
		check(terminal("c") && terminal("b"), "a primary exit keeps the surviving companion visible");
		check(focused() === "b", "a primary exit does not steal typing from the companion");
		document.querySelector<HTMLButtonElement>('[aria-label="Close split view"]')!.click();
		await pause();
		check(
			kills === 0 && !document.querySelector(".terminal-companion"),
			"closing a split does not kill either terminal",
		);

		changeTask({
			...initial,
			question: {
				id: "question",
				text: "Which design?",
				options: [],
				allowText: true,
				askedAt: 3,
				pageId: "decision",
			},
		});
		await pause();
		check(
			document.querySelector<HTMLIFrameElement>(".question iframe")?.src.includes("decision"),
			"a pending question keeps its page when another artifact is latest",
		);
		tab("Plan")!.click();
		await pause();
		changeMode("side");
		await pause();
		window.dispatchEvent(new CustomEvent("ateam:focus-terminal", { detail: "c" }));
		check(
			document.querySelector(".page-pane.fills") && focused() !== "c",
			"a covered narrow-panel terminal cannot take keyboard focus",
		);
		changeMode("full");
		await pause();
		check(
			document.querySelector<HTMLIFrameElement>(".page-pane iframe")?.src.includes("plan"),
			"selected doc survives layout remounts",
		);
		changeTask({ ...initial, id: "other", page: null });
		await pause();
		check(
			!tab("Research") && !tab("Plan"),
			"a task switch cannot display another task's artifact tabs",
		);

		for (let i = 0; i < 205; i++) pages.push({ id: `extra-${i}`, title: `Doc ${i}`, at: 10 + i });
		changeTask({ ...initial, page: pages.at(-1) });
		await pause();
		for (const button of document.querySelectorAll<HTMLButtonElement>(
			'[aria-label^="Hide "][aria-label$=" tab"]',
		))
			button.click();
		await pause();
		const hidden = JSON.parse(localStorage.getItem("ateam.pageChoices") ?? "[]");
		check(
			hidden.length === pages.length &&
				hidden.every((entry: [string, boolean]) => entry[1] === false),
			"hiding more than 200 docs preserves every hidden-tab choice",
		);
		check(errors.length === 0, `no handler errors: ${errors.map(String).join(", ")}`);
		return `${checks.length} task workspace checks passed\n${checks.join("\n")}`;
	},
});
