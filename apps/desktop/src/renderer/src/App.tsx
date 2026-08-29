import type {
	AgentDTO,
	ConnectionDTO,
	DiffResultDTO,
	KanbanColumn,
	LoopDTO,
	ProjectDTO,
	SessionDTO,
	SessionHitDTO,
	TaskDTO,
} from "@ateam/protocol";
import {
	ArrowDownToLine,
	ArrowUp,
	ArrowUpDown,
	Brush,
	Check,
	ChevronDown,
	ChevronRight,
	ChevronUp,
	Columns2,
	ExternalLink,
	FileCode,
	FolderPlus,
	GitCommitVertical,
	GitMerge,
	History,
	LayoutGrid,
	Lock,
	LockOpen,
	Maximize2,
	Minimize2,
	Monitor,
	PanelLeft,
	Play,
	Plus,
	Repeat,
	RotateCw,
	Rows2,
	Server,
	SquareTerminal,
	Trash2,
	X,
} from "lucide-react";
import { motion, Reorder } from "motion/react";
import {
	type CSSProperties,
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { AgentIcon } from "./components/AgentIcon";
import { CleanupDialog } from "./components/CleanupDialog";
import { FileDiffView } from "./components/FileDiffView";
import { IconButton } from "./components/IconButton";
import { LoopsPanel } from "./components/LoopsPanel";
import { Menu } from "./components/Menu";
import { PromptComposer } from "./components/PromptComposer";
import { TaskSearch } from "./components/TaskSearch";
import { TerminalView } from "./components/Terminal";
import { usePrompt } from "./components/usePrompt";
import { activeTerminal, sessionTabs } from "./session-tabs";
import { matchesTagQuery, tagsFor, taskIcon } from "./task-tags";
import { byWhatsNext, relativeAge } from "./triage-order";
import { type Alias, aliasLabel, type UnifiedProject, unifyProjects } from "./unify";

const COLUMNS: { key: KanbanColumn; label: string }[] = [
	{ key: "todo", label: "Backlog" },
	{ key: "running", label: "In Progress" },
	{ key: "needs_attention", label: "Needs You" },
	{ key: "review", label: "Review" },
	{ key: "merged", label: "Done" },
];

// ---- sidebar task ordering ----
type TaskSortMode = "next" | "status" | "updated" | "custom";

// ---- mission control layout ----
// How agent tiles are arranged: "grid" is a 2x2 overview (tiles half the
// window wide and tall), "split" lays them side-by-side at full window
// height, "stack" stacks them full-width. Extra tiles go to further pages,
// flipped via the bottom-right pager or Cmd/Ctrl+Alt+Up/Down.
type McLayout = "grid" | "split" | "stack";

// Tiles per page: how many terminals each layout actually shows at once.
const MC_PAGE_SIZE: Record<McLayout, number> = { grid: 4, split: 2, stack: 1 };

// Status order: what needs the user's eyes first.
const STATUS_RANK: Record<KanbanColumn, number> = {
	review: 0,
	needs_attention: 1,
	running: 2,
	todo: 3,
	merged: 4,
};

const springy = { type: "spring", stiffness: 550, damping: 42 } as const;

// Minimum (and default) expanded-sidebar width in px. The resizer never shrinks
// below this; the upper bound is 50% of the window (see startSidebarResize).
const MIN_SIDEBAR_W = 240;

export function App() {
	// Non-null in a detached window: this window is pinned to one project and
	// hides the project switcher; null in the main multi-project dashboard.
	const boundProjectId = useMemo(() => window.ateam.window.boundProjectId(), []);
	const [projects, setProjects] = useState<ProjectDTO[]>([]);
	// projectId/taskId → owning engine alias (null = local). Learned by the main-process
	// aggregate from every engine's reads; drives unification + per-task origin badges.
	const [origins, setOrigins] = useState<Record<string, Alias>>({});
	// The ~/.ssh/config boxes a task can be sent to run on (the composer's "Run on"
	// list). Connecting + cloning the repo onto one happens at task-create time.
	const [connections, setConnections] = useState<ConnectionDTO[]>([]);
	// Which agents each connected engine actually has installed (its system:hello
	// agents), keyed by alias ("local" for this Mac). Drives per-environment agent
	// availability in the composer — you can only pick an agent the box really has.
	const [envAgents, setEnvAgents] = useState<Record<string, string[]>>({});
	// The active repo's `origin` remote URL (null = local-only). A task can go remote
	// only if there's a remote to clone the project from onto the box.
	const [activeRepoRemote, setActiveRepoRemote] = useState<string | null>(null);
	const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
	const [tasksByProject, setTasksByProject] = useState<Record<string, TaskDTO[]>>({});
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
	const [agents, setAgents] = useState<AgentDTO[]>([]);
	const [view, setView] = useState<"board" | "mission" | "loops">("board");
	const [mcLayout, setMcLayoutState] = useState<McLayout>(
		() => (localStorage.getItem("ateam.mcLayout") as McLayout) || "grid",
	);
	const setMcLayout = (l: McLayout) => {
		localStorage.setItem("ateam.mcLayout", l);
		setMcLayoutState(l);
	};
	// Mission Control lock: locked freezes tile order for the whole visit (it
	// re-snapshots the tasks-list order each time you land on Mission Control);
	// unlocked follows the tasks-list order live, pinning only the tile being
	// typed in.
	const [mcLocked, setMcLockedState] = useState(() => localStorage.getItem("ateam.mcLock") === "1");
	const setMcLocked = (v: boolean) => {
		localStorage.setItem("ateam.mcLock", v ? "1" : "0");
		setMcLockedState(v);
	};
	const [panelMode, setPanelMode] = useState<"side" | "full">("side");
	const [projectsCollapsed, setProjectsCollapsed] = useState(false);
	const [tasksCollapsed, setTasksCollapsed] = useState(false);
	const [loopsCollapsed, setLoopsCollapsed] = useState(true);
	// Every engine's loops (merged), for the sidebar LOOPS section. Each loop
	// owns one persistent task (loop.taskId); those tasks show under LOOPS.
	const [loops, setLoops] = useState<LoopDTO[]>([]);
	const [rail, setRail] = useState(() => localStorage.getItem("ateam.sidebarRail") === "1");
	const toggleRail = () => {
		setRail((r) => {
			localStorage.setItem("ateam.sidebarRail", r ? "0" : "1");
			return !r;
		});
	};
	// Draggable sidebar width. Floor is the default 240px (can't shrink below
	// what it is now); the 50%-of-window cap is enforced both here while dragging
	// and in CSS (min(var(--sidebar-w), 50%)) so it survives window resizes.
	const [sidebarWidth, setSidebarWidth] = useState(() => {
		const saved = Number(localStorage.getItem("ateam.sidebarWidth"));
		return Number.isFinite(saved) && saved >= MIN_SIDEBAR_W ? saved : MIN_SIDEBAR_W;
	});
	const startSidebarResize = (e: ReactMouseEvent) => {
		e.preventDefault();
		const startX = e.clientX;
		const startW = sidebarWidth;
		let latest = startW;
		const onMove = (ev: MouseEvent) => {
			const max = Math.round(window.innerWidth * 0.5);
			latest = Math.min(max, Math.max(MIN_SIDEBAR_W, startW + (ev.clientX - startX)));
			setSidebarWidth(latest);
		};
		const onUp = () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
			localStorage.setItem("ateam.sidebarWidth", String(latest));
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
		// Keep the resize cursor and suppress text selection for the whole drag.
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
	};
	const [taskSort, setTaskSortState] = useState<TaskSortMode>(
		() => (localStorage.getItem("ateam.taskSort") as TaskSortMode) || "next",
	);
	const [customOrder, setCustomOrder] = useState<string[]>([]);
	const [cleanupOpen, setCleanupOpen] = useState(false);
	const [composerOpen, setComposerOpen] = useState(false);
	// Free-text task filter driven by the centered search bar in the topbar.
	// Filters the sidebar list and the board by task name; the selected task
	// stays open even when it doesn't match, so searching never yanks it away.
	const [taskQuery, setTaskQuery] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [info, setInfo] = useState<string | null>(null);
	// Which of a task's live sessions is showing in its panel — the active tab.
	// The sessions themselves live in the PTY daemon; this is only the choice of
	// which one to look at, and goes null when a task has none left.
	const [termByTask, setTermByTask] = useState<Record<string, string | null>>({});
	const { ui: promptUi, ask, confirm } = usePrompt();

	const run = useCallback(async (fn: () => Promise<void>) => {
		try {
			await fn();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	const loadTasks = useCallback(async (projectId: string) => {
		const list = await window.ateam.tasks.list(projectId);
		setTasksByProject((prev) => ({ ...prev, [projectId]: list }));
	}, []);

	const loadProjects = useCallback(async () => {
		// projects.list() merges every connected engine's projects (main/aggregate.ts);
		// origins() then reports which engine owns each, learned during that same read.
		const list = await window.ateam.projects.list();
		const scoped = boundProjectId ? list.filter((p) => p.id === boundProjectId) : list;
		setProjects(scoped);
		setOrigins(await window.ateamHost.origins());
		setActiveProjectId((cur) => {
			if (boundProjectId) return boundProjectId;
			// Keep the current project only if it still exists (a box may have dropped).
			if (cur && scoped.some((p) => p.id === cur)) return cur;
			return scoped[0]?.id ?? null;
		});
		// Drop task buckets for projects that vanished (e.g. a disconnected box).
		setTasksByProject((prev) => {
			const live = new Set(scoped.map((p) => p.id));
			const next: Record<string, TaskDTO[]> = {};
			for (const [pid, tks] of Object.entries(prev)) if (live.has(pid)) next[pid] = tks;
			return next;
		});
	}, [boundProjectId]);

	useEffect(() => {
		void loadProjects();
		void window.ateam.agents.list().then(setAgents);
		// Loops for the sidebar section. Always re-list on the push event — the
		// event payload carries ONE engine's loops, the sidebar wants the union.
		void window.ateam.loops.list().then(setLoops);
		const offLoops = window.ateam.loops.onUpdated(
			() => void window.ateam.loops.list().then(setLoops),
		);
		// Upsert: replace a known task, or add one created in another window (so a
		// project open in two windows stays consistent). Only for projects this
		// window tracks — a detached window ignores other projects' tasks.
		const offUpdated = window.ateam.events.onTaskUpdated((updated) => {
			setTasksByProject((prev) => {
				const list = prev[updated.projectId];
				if (!list) return prev;
				const nextList = list.some((t) => t.id === updated.id)
					? list.map((t) => (t.id === updated.id ? updated : t))
					: [...list, updated];
				return { ...prev, [updated.projectId]: nextList };
			});
		});
		// Removal (delete/cleanup) from any window — drop the card everywhere and
		// clear the selection if it was pointing at the now-gone task.
		const offRemoved = window.ateam.events.onTaskRemoved((taskId) => {
			setTasksByProject((prev) => {
				const next: Record<string, TaskDTO[]> = {};
				for (const [pid, list] of Object.entries(prev)) {
					next[pid] = list.filter((t) => t.id !== taskId);
				}
				return next;
			});
			setSelectedTaskId((cur) => (cur === taskId ? null : cur));
		});
		return () => {
			offLoops();
			offUpdated();
			offRemoved();
		};
	}, [loadProjects]);

	// Load the selected project's tasks whenever it changes.
	useEffect(() => {
		if (activeProjectId) void loadTasks(activeProjectId);
	}, [activeProjectId, loadTasks]);

	// Engines are held concurrently now: connecting a box or dropping one doesn't
	// swap the world, it changes which engines' projects are in the union. Reconcile
	// additively — reload the merged projects/origins/agents WITHOUT wiping the
	// current selection (loadProjects keeps the active project if it still exists and
	// prunes tasks for any engine that vanished).
	useEffect(() => {
		return window.ateamHost.onConnectionsChanged(() => {
			void loadProjects();
			void window.ateam.agents.list().then(setAgents);
			void window.ateam.loops.list().then(setLoops);
		});
	}, [loadProjects]);

	// The ~/.ssh/config box list for the composer's "Run on" picker + each connected
	// engine's installed agents, kept fresh as boxes connect/disconnect.
	useEffect(() => {
		const load = () => {
			void window.ateamHost.list().then(setConnections);
			void window.ateamHost.connected().then((list) => {
				const map: Record<string, string[]> = {};
				for (const s of list) map[s.alias ?? "local"] = s.info.agents;
				setEnvAgents(map);
			});
		};
		load();
		return window.ateamHost.onConnectionsChanged(load);
	}, []);

	// Load every project's tasks so non-selected projects can surface their
	// attention state (pulsing dot); evtTaskUpdated keeps them fresh after.
	useEffect(() => {
		for (const p of projects) void loadTasks(p.id);
	}, [projects, loadTasks]);

	// A detached window takes its pinned project's name as the OS window title, so
	// the windows are tellable apart across desktops/Spaces.
	useEffect(() => {
		if (!boundProjectId) return;
		const p = projects.find((x) => x.id === boundProjectId);
		if (p) document.title = p.name;
	}, [boundProjectId, projects]);

	// Highest-priority alert among a non-selected card's tasks (across all its engines).
	const cardAlert = (card: UnifiedProject): "needs_attention" | "review" | null => {
		if (card.members.some((m) => m.projectId === activeProjectId)) return null;
		const list = card.members.flatMap((m) => tasksByProject[m.projectId] ?? []);
		if (list.some((t) => t.column === "needs_attention")) return "needs_attention";
		if (list.some((t) => t.column === "review")) return "review";
		return null;
	};

	// The project a detached window is pinned to (for its static header).
	const boundProject = boundProjectId
		? (projects.find((p) => p.id === boundProjectId) ?? null)
		: null;

	// Group the merged projects into one card per repo (same GitHub owner/name across
	// engines), remembering each engine's projectId — the routing key for its tasks.
	const unifiedProjects = useMemo(() => unifyProjects(projects, origins), [projects, origins]);
	// The card the active project belongs to, and every engine holding that repo.
	const activeCard = useMemo(
		() =>
			unifiedProjects.find((c) => c.members.some((m) => m.projectId === activeProjectId)) ?? null,
		[unifiedProjects, activeProjectId],
	);
	const activeMembers = activeCard?.members ?? [];
	// Session search runs on each engine that holds this repo: the transcripts
	// live on the machine that ran the agent, so a box searches its own disk.
	const searchProjectIds = useMemo(
		() =>
			activeMembers.length > 0
				? activeMembers.map((m) => m.projectId)
				: activeProjectId
					? [activeProjectId]
					: [],
		[activeMembers, activeProjectId],
	);
	// Which engine a task runs on = the engine that owns its project (tasks never
	// migrate between engines, so origin is intrinsic to the projectId).
	const originOf = useCallback((projectId: string): Alias => origins[projectId] ?? null, [origins]);

	// "Run on" options for a new task: this Mac (if the repo is here) + every
	// ~/.ssh/config box. A box clones the project from its git remote, so boxes are
	// disabled for a repo with no remote (nothing to clone).
	const activeRepoProjectId =
		activeCard?.members.find((m) => m.alias === null)?.projectId ??
		activeCard?.members[0]?.projectId ??
		null;
	// Fetch the active repo's remote from its owning engine whenever the card changes.
	useEffect(() => {
		if (!activeRepoProjectId) {
			setActiveRepoRemote(null);
			return;
		}
		let cancelled = false;
		void window.ateam.projects.remoteUrl(activeRepoProjectId).then((url) => {
			if (!cancelled) setActiveRepoRemote(url);
		});
		return () => {
			cancelled = true;
		};
	}, [activeRepoProjectId]);
	// Connecting is what registers a Tailscale box: it resolves the endpoint, gates
	// the protocol version, and only saves it on success — so a typo or an
	// unreachable box leaves nothing behind to clean up.
	const addTailscaleBox = useCallback(async (endpoint: string) => {
		await window.ateamHost.connect(endpoint);
	}, []);
	// Remove a box from the "Run on" list. The main process disconnects it if held
	// and forgets the saved record (an ssh_config alias is flagged hidden — the
	// config file itself is never touched); the connections-changed broadcast then
	// refreshes the list here. Setting the box up again brings it back.
	const forgetBox = useCallback(async (alias: string) => {
		await window.ateamHost.forget(alias);
	}, []);
	// Set up a fresh box over SSH: install() runs the (idempotent) installer on the
	// box, streaming its output via onInstallLog, and connects on success. The
	// onConnectionsChanged reconcile then folds the new box into the environment list.
	const installBox = useCallback(async (dest: string, onLog: (chunk: string) => void) => {
		const off = window.ateamHost.onInstallLog((e) => {
			if (e.dest === dest) onLog(e.chunk);
		});
		try {
			// Return the box's status so the picker can show its readiness checklist.
			return await window.ateamHost.install(dest);
		} finally {
			off();
		}
	}, []);
	// Install a coding agent's CLI on a connected box (streamed via the same install log).
	const installAgentOnBox = useCallback(
		async (alias: string, agentId: string, onLog: (chunk: string) => void) => {
			const off = window.ateamHost.onInstallLog((e) => {
				if (e.dest === alias) onLog(e.chunk);
			});
			try {
				return await window.ateamHost.installAgent(alias, agentId);
			} finally {
				off();
			}
		},
		[],
	);
	const canRemote = activeRepoRemote !== null;
	const hasLocalMember = activeMembers.some((m) => m.alias === null);
	const composerEnvs = useMemo(() => {
		// A box is runnable if it ALREADY has this repo (a member — no clone needed) or
		// the repo has a remote we could clone onto it.
		const memberAliases = new Set(activeMembers.map((m) => m.alias));
		return [
			{ alias: null as Alias, label: "Local", disabled: !hasLocalMember },
			...connections.map((c) => ({
				alias: c.alias,
				label: c.alias,
				disabled: !memberAliases.has(c.alias) && !canRemote,
				transport: c.transport,
				// `known` is only set by a successful connect, so a config alias we've
				// never reached is one the engine has probably never been installed on.
				needsSetup: !c.known,
			})),
		];
	}, [connections, canRemote, hasLocalMember, activeMembers]);

	// The active card's board unions tasks from every engine that has the repo.
	const activeTasks = activeCard
		? activeMembers.flatMap((m) => tasksByProject[m.projectId] ?? [])
		: activeProjectId
			? (tasksByProject[activeProjectId] ?? [])
			: [];
	const selectedTask = activeTasks.find((t) => t.id === selectedTaskId) ?? null;
	// Loops of the active repo card (whichever engine holds them), and the task
	// each one owns. Loop-owned tasks show under LOOPS, not again under TASKS
	// (they stay on the board — it's the status surface).
	const activeLoops = useMemo(() => {
		const memberIds = new Set(activeMembers.map((m) => m.projectId));
		return loops.filter((l) => l.projectId != null && memberIds.has(l.projectId));
	}, [loops, activeMembers]);
	const loopTaskIds = useMemo(() => {
		const ids = new Set<string>();
		for (const l of loops) if (l.taskId) ids.add(l.taskId);
		return ids;
	}, [loops]);
	// Sidebar list shows all non-loop tasks, including merged/done ones.
	const sidebarTasks = useMemo(
		() => activeTasks.filter((t) => !loopTaskIds.has(t.id)),
		[activeTasks, loopTaskIds],
	);

	// Sidebar ordering: by status (Review → Needs You → In Progress → Backlog),
	// most-recently-updated first, or a hand-dragged custom order.
	const setTaskSort = (mode: TaskSortMode) => {
		setTaskSortState(mode);
		localStorage.setItem("ateam.taskSort", mode);
	};
	useEffect(() => {
		if (!activeProjectId) return;
		try {
			setCustomOrder(
				JSON.parse(localStorage.getItem(`ateam.taskOrder.${activeProjectId}`) ?? "[]") as string[],
			);
		} catch {
			setCustomOrder([]);
		}
	}, [activeProjectId]);
	const reorderTasks = (ids: string[]) => {
		setCustomOrder(ids);
		if (activeProjectId)
			localStorage.setItem(`ateam.taskOrder.${activeProjectId}`, JSON.stringify(ids));
	};
	const orderedSidebarTasks = useMemo(() => {
		const list = [...sidebarTasks];
		if (taskSort === "next") {
			list.sort(byWhatsNext);
		} else if (taskSort === "status") {
			list.sort((a, b) => STATUS_RANK[a.column] - STATUS_RANK[b.column]);
		} else if (taskSort === "updated") {
			list.sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0));
		} else {
			const rank = new Map(customOrder.map((id, i) => [id, i]));
			list.sort(
				(a, b) =>
					(rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
			);
		}
		return list;
	}, [sidebarTasks, taskSort, customOrder]);
	// Stable identity for Mission Control: a fresh array every render would make
	// its follow-the-tasks-order effect re-run on every App render.
	const sidebarOrderIds = useMemo(
		() => orderedSidebarTasks.map((t) => t.id),
		[orderedSidebarTasks],
	);

	// Case-insensitive substring match across the task's name, branch, and
	// description. Empty query matches all. A leading `#` switches to a tag
	// filter instead — "#bug" narrows the board to bug-tagged work, which is the
	// whole point of having a cross-cutting axis.
	const query = taskQuery.trim().toLowerCase();
	const matchesQuery = useCallback(
		(t: TaskDTO) => {
			if (query === "") return true;
			if (query.startsWith("#")) return matchesTagQuery(query, t);
			return (
				t.name.toLowerCase().includes(query) ||
				t.branch.toLowerCase().includes(query) ||
				(t.description?.toLowerCase().includes(query) ?? false)
			);
		},
		[query],
	);
	// Sidebar and board both honor the search; Mission Control and the selected
	// task deliberately don't (a live agent tile / open panel shouldn't vanish).
	const visibleSidebarTasks = useMemo(
		() => orderedSidebarTasks.filter(matchesQuery),
		[orderedSidebarTasks, matchesQuery],
	);
	const filteredBoardTasks = useMemo(
		() => activeTasks.filter(matchesQuery),
		[activeTasks, matchesQuery],
	);

	// Each project remembers its last view (selected task, side/full, board vs
	// mission) so switching back lands exactly where you left off.
	const viewMemRef = useRef<
		Record<
			string,
			{
				taskId: string | null;
				mode: "side" | "full";
				view: "board" | "mission" | "loops";
			}
		>
	>({});
	const selectProject = (id: string) => {
		if (id === activeProjectId) return;
		if (activeProjectId) {
			viewMemRef.current[activeProjectId] = {
				taskId: selectedTaskId,
				mode: panelMode,
				view,
			};
		}
		const mem = viewMemRef.current[id];
		setActiveProjectId(id);
		setSelectedTaskId(mem?.taskId ?? null);
		setPanelMode(mem?.mode ?? "side");
		setView(mem?.view ?? "board");
	};
	// Opening a task IS reading it — the hooks set `isUnread` on Stop /
	// PermissionRequest and nothing ever cleared it. Only explicit user
	// selection clears it: restoring a remembered selection on a project
	// switch must not silently mark things read the user never looked at.
	const markRead = (id: string) => {
		// Skip the round trip (and its broadcast) for a task already read.
		const t = Object.values(tasksByProject)
			.flat()
			.find((x) => x.id === id);
		if (!t?.isUnread) return;
		void window.ateam.tasks.markRead(id).catch(() => {});
	};
	// From the sidebar → open full width. From the board → open on the side.
	const openTask = (t: TaskDTO) => {
		setActiveProjectId(t.projectId);
		setSelectedTaskId(t.id);
		markRead(t.id);
		setPanelMode("full");
		setView("board");
	};
	const selectFromBoard = (id: string) => {
		setSelectedTaskId(id);
		markRead(id);
		setPanelMode("side");
	};
	// Expanding a Mission Control tile opens that exact terminal full-width.
	// `view` stays "mission", so collapsing or closing the panel lands back on
	// the grid — while the same panel opened from the Board collapses to a
	// side panel there.
	const openFromMission = (task: TaskDTO, terminalId: string) => {
		setTermByTask((m) => ({ ...m, [task.id]: terminalId }));
		setSelectedTaskId(task.id);
		markRead(task.id);
		setPanelMode("full");
	};
	// A session-search hit opens the task it ran in, and the exact terminal it
	// ran in when that tab is still alive — the point of the search is to land
	// back where the work happened, not merely near it.
	const openSessionHit = (hit: SessionHitDTO) => {
		const task = activeTasks.find((t) => t.id === hit.taskId);
		if (!task) return;
		if (hit.terminalId) setTermByTask((m) => ({ ...m, [task.id]: hit.terminalId }));
		openTask(task);
	};
	// Collapsing the full panel inside Mission Control means "back to the
	// grid", not "shrink to a side panel" — there is no board to sit beside.
	const collapseToMission = () => {
		setSelectedTaskId(null);
		setPanelMode("side");
	};

	const addProject = () =>
		run(async () => {
			const path = await window.ateam.projects.pick();
			if (!path) return;
			let proj: ProjectDTO;
			try {
				proj = await window.ateam.projects.register(path);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (!/not a git repository/i.test(msg)) throw e;
				// GitHub-Desktop-style: offer to create a repository here instead.
				const ok = await confirm(
					"Not a git repository",
					"This folder isn't a git repository yet. Initialize one here? Ateam will run git init, add a starter .gitignore (if none exists), and make an initial commit of the current files.",
				);
				if (!ok) return;
				proj = await window.ateam.projects.register(path, { init: true });
			}
			await loadProjects();
			selectProject(proj.id);
		});

	const newTask = () => {
		if (activeProjectId) setComposerOpen(true);
	};

	// Delete a task (and its worktree) straight from the sidebar. Confirm first,
	// then reuse the same remove + force-fallback flow as the task panel menu.
	// The onTaskRemoved event listener drops the row and clears the selection.
	const deleteTask = (t: TaskDTO) =>
		run(async () => {
			const ok = await confirm(
				"Delete task?",
				`Permanently delete "${t.name}" and its worktree? This can't be undone.`,
			);
			if (!ok) return;
			try {
				await window.ateam.tasks.remove({ id: t.id, deleteBranch: true });
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (!/modified or untracked|not fully merged|use --force/i.test(msg)) throw e;
				const force = await confirm(
					"Force delete?",
					"This worktree has uncommitted/untracked changes or an unmerged branch. Delete it anyway?",
				);
				if (!force) return;
				await window.ateam.tasks.remove({ id: t.id, deleteBranch: true, force: true });
			}
		});

	// Create the task, open it in the current panel mode (side when on the
	// board, full when already full-width), and launch the chosen agent with
	// the prompt as its first instruction.
	const composeTask = (input: {
		name: string;
		prompt: string;
		agentId: string;
		yolo: boolean;
		files: string[];
		// Chosen environment: null = this Mac; an alias = that box. A box is connected
		// and the repo cloned onto it (idempotent) before the task is created there.
		alias: Alias;
	}) =>
		run(async () => {
			const card = activeCard;
			if (!card) return;
			setComposerOpen(false);
			// Resolve the engine's project row for this repo on the chosen environment.
			let projectId: string;
			if (input.alias === null) {
				const localMember = card.members.find((m) => m.alias === null);
				if (!localMember) {
					setError("This repo isn't on your Mac.");
					return;
				}
				projectId = localMember.projectId;
			} else {
				// If the box already has this repo (it's a member of the card, surfaced by
				// aggregation), use it directly — no clone, no provision. This is the iOS
				// path: the box already has its repos, you just create tasks against them.
				const existing = card.members.find((m) => m.alias === input.alias);
				if (existing) {
					projectId = existing.projectId;
				} else {
					// First task on this box for this repo: it isn't here yet, so clone +
					// register it from the repo's remote, then route the create to it.
					if (!activeRepoRemote) {
						setError("This repo has no git remote to clone onto a box.");
						return;
					}
					setInfo(`Setting up ${card.name} on ${input.alias}…`);
					let proj: ProjectDTO;
					try {
						proj = await window.ateamHost.provision(input.alias, { cloneUrl: activeRepoRemote });
					} finally {
						setInfo(null);
					}
					// Re-list so the aggregate learns proj.id → this box; then create routes there.
					await loadProjects();
					projectId = proj.id;
				}
			}
			const task = await window.ateam.tasks.create({ projectId, name: input.name });
			// The created task's project is a member of the active card, so its tasks
			// are already unioned into the board once loaded.
			await loadTasks(projectId);
			setSelectedTaskId(task.id);
			// Keep whatever panel mode the user is already in: if they're
			// browsing the board (side), open the new task beside it; if they're
			// already full-width, stay full-width.
			setView("board");
			const { terminalId } = await window.ateam.pty.spawnAgent({
				taskId: task.id,
				agentId: input.agentId,
				yolo: input.yolo,
				prompt: input.prompt || undefined,
				files: input.files.length ? input.files : undefined,
			});
			setTermByTask((m) => ({ ...m, [task.id]: terminalId }));
		});

	const cleanup = () => {
		if (activeProjectId) setCleanupOpen(true);
	};

	return (
		<div
			className={`app ${rail ? "rail" : ""}`}
			style={{ "--sidebar-w": `${sidebarWidth}px` } as CSSProperties}
		>
			<aside className={`sidebar ${rail ? "rail" : ""}`}>
				{/* In rail mode the traffic lights own this strip; the toggle moves
				    below them as the first tile. */}
				<div className="side-top">
					{!rail && <IconButton icon={PanelLeft} label="Collapse sidebar" onClick={toggleRail} />}
				</div>

				{rail ? (
					<>
						<button type="button" className="rail-tile" title="Expand sidebar" onClick={toggleRail}>
							<PanelLeft size={16} strokeWidth={1.75} />
						</button>
						<div className="rail-divider" />
						{unifiedProjects.map((card) => {
							const alert = cardAlert(card);
							const primary = card.members.find((m) => m.alias === null) ?? card.members[0];
							if (!primary) return null;
							const active = card.members.some((m) => m.projectId === activeProjectId);
							return (
								<button
									type="button"
									key={card.key}
									className={`rail-tile ${active ? "active" : ""}`}
									title={
										boundProjectId ? card.name : `${card.name} — double-click to open in new window`
									}
									onClick={() => selectProject(primary.projectId)}
									onDoubleClick={
										boundProjectId
											? undefined
											: () => window.ateam.window.openProject(primary.projectId)
									}
								>
									{card.name.charAt(0).toUpperCase()}
									{alert && <span className={`corner pulse ${alert}`} />}
								</button>
							);
						})}
						<div className="rail-divider" />
						<button
							type="button"
							className="rail-tile"
							title="New task"
							onClick={newTask}
							disabled={!activeProjectId}
						>
							<Plus size={16} strokeWidth={1.75} />
						</button>
						{visibleSidebarTasks.map((t) => {
							const Icon = taskIcon(t.name);
							return (
								<button
									type="button"
									key={t.id}
									className={`rail-tile ${t.id === selectedTaskId ? "active" : ""}`}
									title={t.name}
									onClick={() => openTask(t)}
								>
									{t.agentId ? (
										<AgentIcon agentId={t.agentId} size={16} />
									) : (
										<Icon size={16} strokeWidth={1.75} />
									)}
									{t.agentStatus && <span className={`corner ${t.agentStatus}`} />}
								</button>
							);
						})}
					</>
				) : (
					<>
						{/* A detached window IS one project — show a static header, not a
						    switchable one-item list. The dashboard keeps the full accordion. */}
						{boundProjectId ? (
							<div className="proj-header">
								<span
									className="dot"
									style={boundProject?.color ? { background: boundProject.color } : undefined}
								/>
								<span className="proj-name" title={boundProject?.repoPath}>
									{boundProject?.name ?? "…"}
								</span>
							</div>
						) : (
							<>
								{/* PROJECTS accordion */}
								<div className="section-head">
									<button
										type="button"
										className="section-toggle"
										onClick={() => setProjectsCollapsed((c) => !c)}
									>
										{projectsCollapsed ? (
											<ChevronRight size={14} strokeWidth={2} />
										) : (
											<ChevronDown size={14} strokeWidth={2} />
										)}
										<span>Projects</span>
									</button>
									<IconButton icon={FolderPlus} label="Add project" onClick={addProject} />
								</div>
								{!projectsCollapsed &&
									unifiedProjects.map((card) => {
										const alert = cardAlert(card);
										// Selecting/detaching acts on the local copy if present, else the first.
										const primary = card.members.find((m) => m.alias === null) ?? card.members[0];
										if (!primary) return null;
										const active = card.members.some((m) => m.projectId === activeProjectId);
										// Show the environments this repo spans (Local · box) when it's on more
										// than just this Mac — that's the multi-engine cue.
										const multiEnv =
											card.members.length > 1 || card.members.some((m) => m.alias !== null);
										return (
											// Double-click (or the hover button) detaches the project into its
											// own window. Row and open-button are siblings so the button's
											// click can't nest inside the row button.
											<div
												key={card.key}
												className="proj-row"
												onDoubleClick={() => window.ateam.window.openProject(primary.projectId)}
											>
												<button
													type="button"
													className={`proj ${active ? "active" : ""}`}
													onClick={() => selectProject(primary.projectId)}
												>
													<span
														className={`dot ${alert ? `alert ${alert}` : ""}`}
														style={!alert && card.color ? { background: card.color } : undefined}
													/>
													<span className="proj-name" title={primary.project.repoPath}>
														{card.name}
													</span>
													{multiEnv && (
														// One icon per environment — a monitor for this Mac, a server per
														// box — instead of the names, which crowded the row as soon as a
														// repo spanned more than one box. The name is the hover title
														// (and the accessible name, so the row still reads its
														// environments aloud). Monitor, not Laptop: lucide draws Laptop
														// only 15 units tall inside the 24-unit box against Server's 20,
														// so the pair looked mismatched at the same `size`. Monitor is
														// 18 and exactly as wide, which reads as even.
														<span className="proj-envs">
															{card.members.map((m) => {
																const name = aliasLabel(m.alias);
																return (
																	<span
																		key={m.alias ?? "local"}
																		className="proj-env"
																		title={name}
																		role="img"
																		aria-label={name}
																	>
																		{m.alias === null ? (
																			<Monitor size={12} strokeWidth={1.75} aria-hidden="true" />
																		) : (
																			<Server size={12} strokeWidth={1.75} aria-hidden="true" />
																		)}
																	</span>
																);
															})}
														</span>
													)}
												</button>
												<span className="proj-open">
													<IconButton
														icon={ExternalLink}
														label="Open in new window"
														size={14}
														onClick={() => window.ateam.window.openProject(primary.projectId)}
													/>
												</span>
											</div>
										);
									})}
							</>
						)}

						{/* TASKS accordion — active tasks of the selected project */}
						<div className="section-head tasks-head">
							<button
								type="button"
								className="section-toggle"
								onClick={() => setTasksCollapsed((c) => !c)}
							>
								{tasksCollapsed ? (
									<ChevronRight size={14} strokeWidth={2} />
								) : (
									<ChevronDown size={14} strokeWidth={2} />
								)}
								<span>Tasks</span>
							</button>
							<span style={{ display: "flex", gap: 2 }}>
								<Menu
									icon={ArrowUpDown}
									label="Order tasks"
									items={[
										{
											label: "What's next",
											icon: taskSort === "next" ? Check : undefined,
											onClick: () => setTaskSort("next"),
										},
										{
											label: "By status",
											icon: taskSort === "status" ? Check : undefined,
											onClick: () => setTaskSort("status"),
										},
										{
											label: "Last updated first",
											icon: taskSort === "updated" ? Check : undefined,
											onClick: () => setTaskSort("updated"),
										},
										{
											label: "Custom (drag to reorder)",
											icon: taskSort === "custom" ? Check : undefined,
											onClick: () => setTaskSort("custom"),
										},
									]}
								/>
								<IconButton
									icon={Plus}
									label="New task"
									onClick={newTask}
									disabled={!activeProjectId}
								/>
							</span>
						</div>
						{!tasksCollapsed &&
							(!activeProjectId ? (
								<div className="tree-empty">Select a project</div>
							) : visibleSidebarTasks.length === 0 ? (
								<div className="tree-empty">{query ? "No matching tasks" : "No active tasks"}</div>
							) : taskSort === "custom" && !query ? (
								// Custom order: drag rows up/down; Motion animates the shuffle.
								// Disabled while searching — reordering a filtered subset would
								// drop the hidden tasks from the saved order.
								<Reorder.Group
									as="div"
									axis="y"
									values={orderedSidebarTasks.map((t) => t.id)}
									onReorder={reorderTasks}
								>
									{orderedSidebarTasks.map((t) => (
										<Reorder.Item as="div" key={t.id} value={t.id} transition={springy}>
											<TaskRow
												task={t}
												selected={t.id === selectedTaskId}
												onClick={() => openTask(t)}
												onDelete={() => deleteTask(t)}
											/>
										</Reorder.Item>
									))}
								</Reorder.Group>
							) : (
								// Sorted modes: layout animation glides rows to their new spot
								// when a status change or update reorders them.
								visibleSidebarTasks.map((t) => (
									<motion.div key={t.id} layout transition={springy}>
										<TaskRow
											task={t}
											selected={t.id === selectedTaskId}
											onClick={() => openTask(t)}
											onDelete={() => deleteTask(t)}
										/>
									</motion.div>
								))
							))}

						{/* LOOPS accordion — the active repo's scheduled agent sessions.
						    Each loop owns one persistent task; clicking a row opens that
						    task's terminal (or the Loops tab before its first run).
						    loops-side-head floats it to the sidebar's bottom while there
						    is spare room; a long task list pushes it down naturally. */}
						<div className="section-head tasks-head loops-side-head">
							<button
								type="button"
								className="section-toggle"
								onClick={() => setLoopsCollapsed((c) => !c)}
							>
								{loopsCollapsed ? (
									<ChevronRight size={14} strokeWidth={2} />
								) : (
									<ChevronDown size={14} strokeWidth={2} />
								)}
								<span>Loops</span>
							</button>
							<IconButton
								icon={Plus}
								label="New loop"
								onClick={() => setView("loops")}
								disabled={!activeProjectId}
							/>
						</div>
						{!loopsCollapsed &&
							(activeLoops.length === 0 ? (
								<div className="tree-empty">No loops</div>
							) : (
								activeLoops.map((l) => {
									const task = l.taskId
										? (activeTasks.find((t) => t.id === l.taskId) ?? null)
										: null;
									return (
										<LoopRow
											key={l.id}
											loop={l}
											task={task}
											selected={task != null && task.id === selectedTaskId}
											onClick={() => (task ? openTask(task) : setView("loops"))}
										/>
									);
								})
							))}
					</>
				)}
			</aside>

			{/* Drag the sidebar/main divider to resize. Hidden in rail mode, which
			    has a fixed width. */}
			{!rail && (
				<div
					className="sidebar-resizer"
					onMouseDown={startSidebarResize}
					role="separator"
					aria-orientation="vertical"
					aria-label="Resize sidebar"
				/>
			)}

			<main className="main">
				<div className="topbar">
					<div className="tabs">
						<div
							className={`tab ${view === "board" && !(selectedTask && panelMode === "full") ? "active" : ""}`}
							onClick={() => {
								// A full-width task hides the board — clicking "Board" while
								// one is open means "show me the board", so deselect it.
								if (panelMode === "full") setSelectedTaskId(null);
								setView("board");
							}}
						>
							Board
						</div>
						<div
							className={`tab ${view === "mission" ? "active" : ""}`}
							onClick={() => {
								// Same as Board: a full-width task covers this view, so
								// clicking the tab means "show me Mission Control".
								if (panelMode === "full") setSelectedTaskId(null);
								setView("mission");
							}}
						>
							Mission Control
						</div>
						<div
							className={`tab ${view === "loops" ? "active" : ""}`}
							onClick={() => setView("loops")}
						>
							Loops
						</div>
					</div>
					{/* Centered task search — absolutely centered in the topbar so the
					    tabs on the left and action buttons on the right don't shift it. */}
					<TaskSearch
						query={taskQuery}
						onQuery={setTaskQuery}
						projectIds={searchProjectIds}
						onOpen={openSessionHit}
					/>
					<div className="spacer" />
					{view === "mission" && !(selectedTask && panelMode === "full") && (
						<div className="mclayout" role="group" aria-label="Layout">
							{(
								[
									["grid", LayoutGrid, "Grid"],
									["split", Columns2, "Split"],
									["stack", Rows2, "Stack"],
								] as const
							).map(([mode, Icon, label]) => (
								<button
									key={mode}
									type="button"
									className={`navbtn icon ${mcLayout === mode ? "active" : ""}`}
									title={`${label} layout`}
									aria-label={`${label} layout`}
									aria-pressed={mcLayout === mode}
									onClick={() => setMcLayout(mode)}
								>
									<Icon size={14} strokeWidth={1.75} />
								</button>
							))}
							<button
								type="button"
								className={`navbtn icon ${mcLocked ? "active" : ""}`}
								title={
									mcLocked
										? "Layout locked: tile order is frozen while you watch"
										: "Lock layout (unlocked: tiles follow the tasks list order; the tile you type in stays put)"
								}
								aria-label="Lock layout"
								aria-pressed={mcLocked}
								onClick={() => setMcLocked(!mcLocked)}
							>
								{mcLocked ? (
									<Lock size={14} strokeWidth={1.75} />
								) : (
									<LockOpen size={14} strokeWidth={1.75} />
								)}
							</button>
						</div>
					)}
					<button type="button" className="navbtn" onClick={cleanup} disabled={!activeProjectId}>
						<Brush size={14} strokeWidth={1.75} />
						Clean up
					</button>
					<button type="button" className="navbtn" onClick={newTask} disabled={!activeProjectId}>
						<Plus size={14} strokeWidth={1.75} />
						New task
					</button>
				</div>

				<div className="content">
					{view === "board" ? (
						<>
							{!(selectedTask && panelMode === "full") && (
								<Board
									tasks={filteredBoardTasks}
									selectedId={selectedTaskId}
									onSelect={selectFromBoard}
									onDeselect={() => setSelectedTaskId(null)}
									// Badge a card only when it runs on a box — Local is the default, so
									// tagging it would be noise. `null` = no badge.
									originLabel={(t) => {
										const a = originOf(t.projectId);
										return a ? aliasLabel(a) : null;
									}}
								/>
							)}
							{selectedTask && (
								<TaskPanel
									task={selectedTask}
									agents={agents}
									envAgents={envAgents}
									alias={originOf(selectedTask.projectId)}
									onInstallAgent={installAgentOnBox}
									mode={panelMode}
									onSetMode={setPanelMode}
									terminalId={termByTask[selectedTask.id] ?? null}
									setTerminal={(tid) => setTermByTask((m) => ({ ...m, [selectedTask.id]: tid }))}
									run={run}
									ask={ask}
									confirm={confirm}
									reload={() => activeProjectId && loadTasks(activeProjectId)}
									onClose={(taskId) =>
										setSelectedTaskId((cur) => (taskId == null || cur === taskId ? null : cur))
									}
								/>
							)}
						</>
					) : view === "mission" ? (
						selectedTask && panelMode === "full" ? (
							<TaskPanel
								task={selectedTask}
								agents={agents}
								envAgents={envAgents}
								alias={originOf(selectedTask.projectId)}
								onInstallAgent={installAgentOnBox}
								mode={panelMode}
								onSetMode={(m) => (m === "side" ? collapseToMission() : setPanelMode(m))}
								collapseLabel="Back to Mission Control"
								terminalId={termByTask[selectedTask.id] ?? null}
								setTerminal={(tid) => setTermByTask((m) => ({ ...m, [selectedTask.id]: tid }))}
								run={run}
								ask={ask}
								confirm={confirm}
								reload={() => activeProjectId && loadTasks(activeProjectId)}
								onClose={(taskId) =>
									setSelectedTaskId((cur) => (taskId == null || cur === taskId ? null : cur))
								}
							/>
						) : (
							<MissionControl
								tasks={activeTasks}
								agents={agents}
								order={sidebarOrderIds}
								layout={mcLayout}
								locked={mcLocked}
								onExpand={openFromMission}
							/>
						)
					) : (
						<LoopsPanel />
					)}
				</div>
			</main>

			{cleanupOpen && activeProjectId && (
				<CleanupDialog
					projectId={activeProjectId}
					confirm={confirm}
					reload={() => activeProjectId && loadTasks(activeProjectId)}
					onClose={() => setCleanupOpen(false)}
				/>
			)}
			{composerOpen && activeCard && (
				<PromptComposer
					agents={agents}
					environments={composerEnvs}
					envAgents={envAgents}
					onAdd={addTailscaleBox}
					onInstall={installBox}
					onForget={forgetBox}
					onInstallAgent={installAgentOnBox}
					onClose={() => setComposerOpen(false)}
					onCreate={composeTask}
				/>
			)}
			{promptUi}
			{error && (
				<div className="toast" onClick={() => setError(null)}>
					{error}
				</div>
			)}
			{info && (
				<div className="toast info" onClick={() => setInfo(null)}>
					{info}
				</div>
			)}
		</div>
	);
}

function TaskRow({
	task: t,
	selected,
	onClick,
	onDelete,
}: {
	task: TaskDTO;
	selected: boolean;
	onClick: () => void;
	onDelete: () => void;
}) {
	const Icon = taskIcon(t.name);
	// Row and trailing slot are siblings so the trash click can't nest inside the
	// row button (same pattern as proj-row / proj-open above). The status dot and
	// delete button share the trailing slot and swap in place on hover.
	return (
		<div className="tasknode-row">
			<button type="button" className={`tasknode ${selected ? "selected" : ""}`} onClick={onClick}>
				{t.agentId ? (
					<span className="ticon">
						<AgentIcon agentId={t.agentId} size={14} />
					</span>
				) : (
					<Icon className="ticon" size={14} strokeWidth={1.75} />
				)}
				<span className={`tname ${t.isUnread ? "unread-row" : ""}`}>{t.name}</span>
			</button>
			<span className="task-trail">
				{t.agentStatus && <span className={`tstatus ${t.agentStatus}`} />}
				<IconButton
					icon={Trash2}
					label="Delete task"
					variant="danger"
					size={14}
					onClick={onDelete}
				/>
			</span>
		</div>
	);
}

/** Sidebar row for a loop — mirrors TaskRow, with the loop's task supplying
 *  the status dot. A paused loop renders dimmed. */
function LoopRow({
	loop,
	task,
	selected,
	onClick,
}: {
	loop: LoopDTO;
	task: TaskDTO | null;
	selected: boolean;
	onClick: () => void;
}) {
	return (
		<div className="tasknode-row">
			<button
				type="button"
				className={`tasknode ${selected ? "selected" : ""} ${loop.enabled ? "" : "loop-paused"}`}
				onClick={onClick}
			>
				<span className="ticon">
					<Repeat size={14} strokeWidth={1.75} />
				</span>
				<span className="tname">{loop.title}</span>
			</button>
			<span className="task-trail">
				{task?.agentStatus && <span className={`tstatus ${task.agentStatus}`} />}
			</span>
		</div>
	);
}

function Board({
	tasks,
	selectedId,
	onSelect,
	onDeselect,
	originLabel,
}: {
	tasks: TaskDTO[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	onDeselect: () => void;
	/** Engine badge for a task (e.g. a box alias), or null to show none (Local). */
	originLabel: (t: TaskDTO) => string | null;
}) {
	return (
		// Clicking empty board space deselects; card clicks stopPropagation.
		<div className="board" onClick={onDeselect}>
			{COLUMNS.map((col) => {
				const items = tasks.filter((t) => t.column === col.key);
				return (
					<div className="col" key={col.key}>
						<h3>
							{col.label} <span className="count">{items.length}</span>
						</h3>
						{items.map((t) => {
							const tags = tagsFor(t);
							return (
								<motion.div
									key={t.id}
									layout
									transition={springy}
									className={`card ${t.id === selectedId ? "selected" : ""}`}
									onClick={(e) => {
										e.stopPropagation();
										onSelect(t.id);
									}}
								>
									{/* A stalled agent must not wear the live "running" ring — the card
								    would contradict its own caption. */}
									{t.agentStatus && (
										<span
											className={`ring ${t.triage.bucket === "stalled" ? "stalled" : t.agentStatus}`}
										/>
									)}
									<div className="name">
										{t.isUnread && <span className="unread" title="New since you last looked" />}
										{t.name}
									</div>
									{originLabel(t) && (
										<span className="card-env muted" style={{ fontSize: 10 }}>
											{originLabel(t)}
										</span>
									)}
									{/* Tags live in the branch's slot and appear only on hover (the
								    branch is the most redundant line on the card, being a slug of the
								    name). Sharing one fixed-height row means hovering never reflows
								    the board. */}
									<div className={`branch-slot ${tags.length ? "has-tags" : ""}`}>
										<div className="branch">{t.branch}</div>
										{tags.length > 0 && (
											<div className="tags">
												{tags.map((tag) => (
													<span className="tag" key={tag}>
														{tag}
													</span>
												))}
											</div>
										)}
									</div>
									{/* Why this card is where it is — the triage verdict that until now
								    was computed on every refresh and shown only to the MCP tool. */}
									<div className="triage" title={t.triage.reason}>
										{t.triage.reason}
									</div>
									<div className="meta">
										{t.gitStatus && (
											<span>
												↑{t.gitStatus.ahead} ↓{t.gitStatus.behind} · {t.gitStatus.dirty} changed
											</span>
										)}
										{t.prNumber && <span>PR #{t.prNumber}</span>}
										{/* Age and agent icon share one right-aligned group: the icon used to
									    be absolutely positioned and sat on top of the age label. */}
										<span className="meta-end">
											{relativeAge(t.lastEventAt, Date.now()) && (
												<span className="age">{relativeAge(t.lastEventAt, Date.now())}</span>
											)}
											{t.agentId && <AgentIcon agentId={t.agentId} size={15} />}
										</span>
									</div>
								</motion.div>
							);
						})}
					</div>
				);
			})}
		</div>
	);
}

function TaskPanel({
	task,
	agents,
	envAgents,
	alias,
	onInstallAgent,
	mode,
	onSetMode,
	collapseLabel = "Show beside the board",
	terminalId,
	setTerminal,
	run,
	ask,
	confirm,
	reload,
	onClose,
}: {
	task: TaskDTO;
	agents: AgentDTO[];
	/** Agent ids each engine actually has, keyed by alias ("local" for this Mac) —
	 *  so the session composer only offers what this task's engine can run. */
	envAgents: Record<string, string[]>;
	/** The engine this task runs on; null = this Mac. */
	alias: Alias;
	/** Install a coding agent's CLI on the box, streamed (the agent picker's flow). */
	onInstallAgent: (
		alias: string,
		agentId: string,
		onLog: (chunk: string) => void,
	) => Promise<{ loginCommand?: string }>;
	mode: "side" | "full";
	onSetMode: (m: "side" | "full") => void;
	/** Tooltip for the minimize button — where collapsing takes you. */
	collapseLabel?: string;
	terminalId: string | null;
	setTerminal: (tid: string | null) => void;
	run: (fn: () => Promise<void>) => Promise<void>;
	ask: (title: string, initial?: string) => Promise<string | null>;
	confirm: (title: string, body?: string) => Promise<boolean>;
	reload: () => void;
	onClose: (taskId?: string) => void;
}) {
	// Which agent a relaunch uses when nothing is chosen: the one already on this
	// task, else the first installed. Picking a different one is the composer's job.
	const fallbackAgentId = task.agentId ?? agents.find((a) => a.available)?.id ?? "claude";
	const [sessionComposerOpen, setSessionComposerOpen] = useState(false);
	const [diff, setDiff] = useState<DiffResultDTO | null>(null);
	const [changesOpen, setChangesOpen] = useState(false);
	// The in-app editor (VS Code on the task's machine). Once loaded, the iframe
	// stays mounted and is only hidden — unmounting would drop unsaved buffers.
	const [editorSrc, setEditorSrc] = useState<string | null>(null);
	const [editorOpen, setEditorOpen] = useState(false);
	const [editorBusy, setEditorBusy] = useState<string | null>(null);
	const [viewFile, setViewFile] = useState<string | null>(null);
	// This task's live PTY sessions — agents and shells alike. They ARE the tabs:
	// the daemon already owns as many per task as you like, so there is nothing
	// extra to persist. Tagged with the task they were read for, because the render
	// right after you switch tasks still holds the previous task's list — reading
	// that as this task's would put a foreign terminal in the panel. `null` means
	// "not read yet", which the tab-fallback effect below must not mistake for
	// "this task has no sessions".
	const [loaded, setLoaded] = useState<{ taskId: string; sessions: SessionDTO[] } | null>(null);
	const sessions = loaded?.taskId === task.id ? loaded.sessions : null;

	// Selecting another task closes the changes view.
	useEffect(() => {
		setChangesOpen(false);
		setViewFile(null);
	}, []);

	const refreshSessions = useCallback(async () => {
		const taskId = task.id;
		const live = await window.ateam.pty.listForTask(taskId);
		// The engine hands these back latest-first; reverse so the strip reads
		// oldest → newest — a new session then appends on the right instead of
		// shuffling the tabs already open.
		const ordered = live.reverse();
		setLoaded({ taskId, sessions: ordered });
		return ordered;
	}, [task.id]);

	useEffect(() => {
		void refreshSessions();
		// A session opened in another window is announced as a task update (see the
		// engine's spawn handlers), and one ending anywhere arrives as a pty exit.
		const offUpdated = window.ateam.events.onTaskUpdated((t) => {
			if (t.id === task.id) void refreshSessions();
		});
		const offExit = window.ateam.pty.onExit(() => void refreshSessions());
		return () => {
			offUpdated();
			offExit();
		};
	}, [task.id, refreshSessions]);

	const refreshDiff = useCallback(() => {
		void window.ateam.git.diff(task.id).then(setDiff);
		void window.ateam.git.status(task.id);
	}, [task.id]);

	useEffect(() => {
		refreshDiff();
	}, [refreshDiff]);

	const launch = useCallback(
		(yolo: boolean, resume = false, agent = fallbackAgentId) =>
			run(async () => {
				const { terminalId: tid } = await window.ateam.pty.spawnAgent({
					taskId: task.id,
					agentId: agent,
					yolo,
					resume,
				});
				await refreshSessions();
				setTerminal(tid);
			}),
		[task.id, fallbackAgentId, run, setTerminal, refreshSessions],
	);

	// Keep the active tab pointed at something real. Covers (re)opening a task
	// with surviving daemon sessions, and a session ending — its tab disappears
	// and the newest survivor takes focus. With nothing left, resume the agent's
	// last conversation if the task is still active work (running or awaiting
	// input). Terminal columns (review/merged) are left alone — there a relaunch
	// is a deliberate act via the + menu, not a side effect of opening the task
	// (and spawning would bounce the card back to "running").
	//
	// The one thing `sessions` alone must never settle is "this task has none".
	// A spawn announces itself as a task update — the very event that flips the
	// column to "running" — and that render arrives BEFORE the listForTask it
	// also triggers comes back. Concluding "running, nothing alive" from that
	// stale-empty list is how creating a task opened a second, redundant
	// "--continue" tab beside the one the composer had just launched. So an empty
	// list is re-read before anything is torn down or relaunched, and only when
	// the answer can still change something — otherwise every task that
	// legitimately has no sessions would re-read itself in a loop.
	const autoResumedRef = useRef<string | null>(null);
	useEffect(() => {
		if (!sessions) return; // list not read yet — don't judge the task by it
		const next = activeTerminal(sessions, terminalId);
		if (next) {
			if (next !== terminalId) setTerminal(next);
			return;
		}
		const resumable =
			(task.column === "running" || task.column === "needs_attention") &&
			autoResumedRef.current !== task.id;
		if (terminalId === null && !resumable) return;
		let cancelled = false;
		void refreshSessions().then((live) => {
			if (cancelled || live.length) return; // it wasn't empty after all
			if (terminalId !== null) setTerminal(null);
			if (!resumable) return;
			autoResumedRef.current = task.id;
			void launch(false, true);
		});
		return () => {
			cancelled = true;
		};
	}, [task.id, task.column, sessions, terminalId, setTerminal, launch, refreshSessions]);

	// "+ → New agent session…": the task-creation composer minus name/branch/machine.
	// Launches into THIS task's worktree, so the prompt, attachments, agent and YOLO
	// all mean the same as they do on a new task — only the branch isn't new.
	const composeSession = (input: {
		prompt: string;
		agentId: string;
		yolo: boolean;
		files: string[];
	}) =>
		run(async () => {
			setSessionComposerOpen(false);
			const { terminalId: tid } = await window.ateam.pty.spawnAgent({
				taskId: task.id,
				agentId: input.agentId,
				yolo: input.yolo,
				prompt: input.prompt || undefined,
				files: input.files.length ? input.files : undefined,
			});
			await refreshSessions();
			showTerminal(tid);
		});

	const shell = () =>
		run(async () => {
			const { terminalId: tid } = await window.ateam.pty.spawnShell({
				taskId: task.id,
			});
			await refreshSessions();
			showTerminal(tid);
		});

	const commit = () =>
		run(async () => {
			const msg = await ask("Commit message");
			if (!msg) return;
			await window.ateam.git.commit(task.id, msg);
			refreshDiff();
		});

	const additions = diff?.files.reduce((n, f) => n + f.additions, 0) ?? 0;
	const deletions = diff?.files.reduce((n, f) => n + f.deletions, 0) ?? 0;
	/**
	 * Selecting a tab means "show me that terminal" — so it leaves whatever view
	 * is covering the terminal. Clicking a tab and seeing nothing change (because
	 * the editor still covered it) left no obvious way back out.
	 */
	const showTerminal = (tid: string | null) => {
		setTerminal(tid);
		setEditorOpen(false);
		setChangesOpen(false);
	};

	const toggleChanges = () => {
		if (changesOpen) {
			setChangesOpen(false);
			return;
		}
		refreshDiff();
		setChangesOpen(true);
		setEditorOpen(false);
		if (!viewFile && diff?.files[0]) setViewFile(diff.files[0].path);
	};

	const tabs = sessionTabs(sessions ?? [], agents);

	// Closing a tab kills its PTY — tabs are exactly the live sessions, so there
	// is no "closed but still running" state to explain. Confirm first when the
	// agent is mid-turn or holding a permission prompt, where a stray click would
	// throw away work in progress.
	const closeSession = (s: SessionDTO, label: string) =>
		run(async () => {
			if (s.status === "running" || s.status === "awaiting_input") {
				const ok = await confirm(
					`Close ${label}?`,
					"This session is still working. Closing kills it, and anything mid-turn is lost.",
				);
				if (!ok) return;
			}
			await window.ateam.pty.kill(s.terminalId);
			await refreshSessions();
		});

	// After toggling side/full, hand focus to the terminal so Enter goes to
	// the agent — not back into the toggle button.
	const setModeAndFocusTerm = (m: "side" | "full") => {
		onSetMode(m);
		requestAnimationFrame(() => window.dispatchEvent(new Event("ateam:focus-terminal")));
	};

	return (
		<section className={`panel ${mode === "full" ? "full" : ""}`}>
			<div className="head">
				<div style={{ display: "flex", justifyContent: "space-between" }}>
					<span className="title">{task.name}</span>
					<span style={{ display: "flex", gap: 2 }}>
						{mode === "full" ? (
							<IconButton
								icon={Minimize2}
								label={collapseLabel}
								onClick={() => setModeAndFocusTerm("side")}
							/>
						) : (
							<IconButton
								icon={Maximize2}
								label="Expand to full width"
								onClick={() => setModeAndFocusTerm("full")}
							/>
						)}
						<IconButton icon={X} label="Close" onClick={onClose} />
					</span>
				</div>
				<div className="branch muted">
					{task.branch} ← {task.baseBranch}
				</div>
			</div>

			<div className="actions">
				{/* Left: this task's terminals, and the `+` that opens another. What kind
				    of agent session you get is the composer's question, not a row of
				    buttons — so the row stays legible however many tabs are open. */}
				<div className="sess-tabs" role="tablist" aria-label="Sessions">
					{tabs.map(({ session, label }) => (
						<div
							key={session.terminalId}
							className={`sess-tab ${session.terminalId === terminalId ? "active" : ""}`}
						>
							<button
								type="button"
								role="tab"
								aria-selected={session.terminalId === terminalId}
								className="sess-tab-name"
								title={label}
								onClick={() => showTerminal(session.terminalId)}
							>
								{label}
							</button>
							<button
								type="button"
								className="sess-tab-close"
								aria-label={`Close ${label}`}
								title={`Close ${label}`}
								onClick={() => closeSession(session, label)}
							>
								<X size={11} />
							</button>
						</div>
					))}
					<Menu
						icon={Plus}
						label="New tab"
						items={[
							{
								label: "New agent session…",
								icon: Play,
								onClick: () => setSessionComposerOpen(true),
							},
							{ label: "Terminal", icon: SquareTerminal, onClick: shell },
							{
								label: "Resume last conversation",
								icon: History,
								// launch() is also driven by the tab-fallback effect, which must
								// NOT yank you out of the editor — so only this user gesture does.
								onClick: () => {
									setEditorOpen(false);
									launch(false, true);
								},
							},
						]}
					/>
				</div>

				<span className="spacer" />

				<IconButton
					icon={FileCode}
					active={editorOpen}
					label={editorOpen ? "Back to terminal" : "Edit files (VS Code on the task's machine)"}
					onClick={() => {
						if (editorOpen) {
							setEditorOpen(false);
							return;
						}
						if (editorSrc) {
							setEditorOpen(true);
							setChangesOpen(false);
							return;
						}
						void run(async () => {
							let res = await window.ateam.editor.open(task.id);
							if ("needsInstall" in res) {
								// Inline coding is optional — nothing is installed without a yes.
								const where = alias === null ? "this Mac" : `"${alias}"`;
								const ok = await confirm(
									"Install the inline editor?",
									`Inline coding runs VS Code (code-server) on ${where} — a one-time, user-space install (~200 MB, no root). Install it now? It takes about a minute.`,
								);
								if (!ok) return;
								setEditorOpen(true);
								setChangesOpen(false);
								setEditorBusy(`Installing the inline editor on ${where}…`);
								try {
									await window.ateam.editor.install(task.id);
									res = await window.ateam.editor.open(task.id);
									if ("needsInstall" in res)
										throw new Error("Install finished but the editor is still missing.");
								} catch (e) {
									// Back to the terminal — a blank editor pane would hide it.
									setEditorOpen(false);
									throw e;
								} finally {
									setEditorBusy(null);
								}
							}
							setEditorSrc(`${res.url}/?folder=${encodeURIComponent(task.worktreePath)}`);
							setEditorOpen(true);
							setChangesOpen(false);
						});
					}}
				/>
				<IconButton
					icon={ExternalLink}
					label={
						alias === null
							? "Open worktree in your editor"
							: `Open worktree in your editor (Remote-SSH: ${alias})`
					}
					onClick={() =>
						run(async () => {
							// Optional on the API surface (the phone omits it) — the desktop
							// preload always provides it.
							const res = await window.ateam.utils.openInEditor?.(task.worktreePath, alias);
							if (res && !res.ok) throw new Error(res.reason);
						})
					}
				/>
				<IconButton icon={GitCommitVertical} label="Commit all changes" onClick={commit} />
				<IconButton
					icon={ArrowUp}
					label="Push branch to origin"
					onClick={() => run(() => window.ateam.git.push(task.id))}
				/>
				<IconButton
					icon={ArrowDownToLine}
					label="Update from base branch"
					onClick={() =>
						run(async () => {
							await window.ateam.git.update(task.id);
							refreshDiff();
						})
					}
				/>
				<IconButton
					icon={GitMerge}
					label="Merge via PR (squash) + update local main"
					onClick={() =>
						run(async () => {
							await window.ateam.git.merge(task.id, "squash");
							refreshDiff();
						})
					}
				/>
				<Menu
					items={[
						{
							label: "Remove task & worktree",
							icon: Trash2,
							danger: true,
							onClick: async () => {
								try {
									await window.ateam.tasks.remove({
										id: task.id,
										deleteBranch: true,
									});
								} catch (e) {
									const msg = e instanceof Error ? e.message : String(e);
									if (/modified or untracked|not fully merged|use --force/i.test(msg)) {
										const ok = await confirm(
											"Force delete?",
											"This worktree has uncommitted/untracked changes or an unmerged branch. Delete it anyway?",
										);
										if (!ok) return;
										await run(() =>
											window.ateam.tasks.remove({
												id: task.id,
												deleteBranch: true,
												force: true,
											}),
										);
									} else {
										await run(async () => {
											throw e;
										});
										return;
									}
								}
								onClose(task.id);
								reload();
							},
						},
					]}
				/>

				<button
					type="button"
					className={`diffstat ${changesOpen ? "active" : ""}`}
					title={changesOpen ? "Back to terminal" : "Show changes"}
					onClick={toggleChanges}
				>
					<span className="add">+{additions}</span>
					<span className="del">-{deletions}</span>
				</button>
			</div>

			<div className="panel-body">
				{/* Keep the terminal mounted (xterm state survives) while the
				    changes view is open — just hide it. */}
				<div
					className="term-wrap"
					style={{ display: changesOpen || editorOpen ? "none" : "flex" }}
				>
					{terminalId ? (
						<TerminalView
							terminalId={terminalId}
							showDone={task.column === "review"}
							onDone={() =>
								run(async () => {
									await window.ateam.tasks.setColumn(task.id, "merged");
								})
							}
						/>
					) : (
						<div className="term" style={{ display: "grid", placeItems: "center" }}>
							<span className="muted">Open a tab with + to start a terminal</span>
						</div>
					)}
				</div>

				{sessionComposerOpen && (
					<PromptComposer
						agents={agents}
						variant="session"
						sessionAlias={alias}
						defaultAgentId={fallbackAgentId}
						envAgents={envAgents}
						onInstallAgent={onInstallAgent}
						onClose={() => setSessionComposerOpen(false)}
						onCreate={composeSession}
					/>
				)}

				{(editorSrc || editorBusy) && (
					<div className="editor-wrap" style={{ display: editorOpen ? "flex" : "none" }}>
						{/* VS Code web (code-server) on the task's engine, scoped to the worktree. */}
						{editorSrc ? (
							<iframe className="editor-frame" src={editorSrc} title="Editor" />
						) : (
							<div className="muted" style={{ display: "grid", placeItems: "center", flex: 1 }}>
								{editorBusy}
							</div>
						)}
					</div>
				)}

				{changesOpen && (
					<div className="changes-view">
						<div className="changes">
							<div className="changes-head">
								<strong>Changes</strong>
								<IconButton icon={RotateCw} label="Refresh changes" onClick={refreshDiff} />
							</div>
							{diff?.files.length ? (
								diff.files.map((f) => (
									<button
										type="button"
										key={f.path}
										className={`file ${viewFile === f.path ? "selected" : ""}`}
										title={f.path}
										onClick={() => setViewFile(f.path)}
									>
										<span className="fpath">{f.path}</span>
										<span className="fstat">
											<span className="add">+{f.additions}</span>{" "}
											<span className="del">-{f.deletions}</span>
										</span>
									</button>
								))
							) : (
								<div className="muted" style={{ padding: "4px 10px" }}>
									No changes
								</div>
							)}
						</div>
						<div className="changes-diff">
							{viewFile ? (
								<FileDiffView
									taskId={task.id}
									file={viewFile}
									split={mode === "full"}
									onClose={() => setChangesOpen(false)}
								/>
							) : (
								<div className="muted" style={{ display: "grid", placeItems: "center", flex: 1 }}>
									Select a file to see its diff
								</div>
							)}
						</div>
					</div>
				)}
			</div>
		</section>
	);
}

function MissionControl({
	tasks,
	agents,
	order,
	layout,
	locked,
	onExpand,
}: {
	tasks: TaskDTO[];
	/** Agent catalog, for naming a session's tab the way the task panel does. */
	agents: AgentDTO[];
	order: string[];
	layout: McLayout;
	locked: boolean;
	onExpand: (task: TaskDTO, terminalId: string) => void;
}) {
	// One tile per TASK, not per session: a task with an agent and two shells is
	// one piece of work, and splaying it across three identically-titled tiles
	// told you nothing. The tile shows one session at a time and its tabs switch
	// between them. Creating and closing sessions stays in the task panel, where
	// the + and the ✕ live; a tile is a viewport onto work that already exists.
	const [tiles, setTiles] = useState<{ task: TaskDTO; sessions: SessionDTO[] }[]>([]);
	// Which session each tile is showing, when the viewer has picked one. Absent
	// (or pointing at a session that has since died) falls back to activeTerminal.
	const [shownByTask, setShownByTask] = useState<Record<string, string>>({});
	const tasksRef = useRef(tasks);
	tasksRef.current = tasks;

	// Pages instead of a scroll area: each layout shows a fixed number of tiles
	// at once, and the rest live on further pages. "In view" is then a crisp
	// set — exactly what the reorder-skip below needs.
	const [page, setPage] = useState(0);
	const pageSize = MC_PAGE_SIZE[layout];
	const pageCount = Math.max(1, Math.ceil(tiles.length / pageSize));
	// Clamp in-render (sessions can die, the layout can change page size) so a
	// stale page never shows an empty grid, then sync the state.
	const clampedPage = Math.min(page, pageCount - 1);
	useEffect(() => {
		if (page !== clampedPage) setPage(clampedPage);
	}, [page, clampedPage]);
	const pageRef = useRef(clampedPage);
	pageRef.current = clampedPage;
	const pageSizeRef = useRef(pageSize);
	pageSizeRef.current = pageSize;
	const pageCountRef = useRef(pageCount);
	pageCountRef.current = pageCount;
	// Last flip direction, read by the page transition so it slides the way a
	// scroll would have gone.
	const dirRef = useRef(0);
	const flip = useCallback((d: number) => {
		dirRef.current = d;
		setPage((p) => Math.max(0, Math.min(pageCountRef.current - 1, p + d)));
	}, []);
	// Cmd/Ctrl+Alt+Up/Down flips pages. Capture phase so it wins over the
	// focused xterm textarea; the combo is one no shell binding uses.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!e.altKey || !(e.metaKey || e.ctrlKey)) return;
			if (e.key === "ArrowDown") flip(1);
			else if (e.key === "ArrowUp") flip(-1);
			else return;
			e.preventDefault();
			e.stopPropagation();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [flip]);

	// Locked: snapshot the sidebar's ordering the moment we land here (or flip
	// the lock on) and freeze it, so terminals never shuffle under you while
	// you watch (e.g. "sort by updated" would otherwise reorder live as agents
	// emit events). Unlocked: follow the sidebar's live order, except the tile
	// being typed in keeps its slot (see focusedRef). Tasks not in the active
	// rank sort to the end.
	const orderRef = useRef(order);
	orderRef.current = order;
	const [frozenRank, setFrozenRank] = useState(() => new Map(order.map((id, i) => [id, i])));
	useEffect(() => {
		if (locked) setFrozenRank(new Map(orderRef.current.map((id, i) => [id, i])));
	}, [locked]);
	const liveRank = useMemo(() => new Map(order.map((id, i) => [id, i])), [order]);
	const rank = locked ? frozenRank : liveRank;

	// The tile whose terminal currently has keyboard focus, i.e. the one the
	// user is typing in, keyed by task id. A ref, not state: focus alone must not
	// reorder anything; it only matters at the moment a re-sort happens.
	const focusedRef = useRef<string | null>(null);
	// Latest unsorted tile list, kept so a re-sort (order change, lock flip,
	// blur) doesn't need a fresh round of listForTask calls.
	const sessionsRef = useRef<{ task: TaskDTO; sessions: SessionDTO[] }[]>([]);
	const rankRef = useRef(rank);
	const lockedRef = useRef(locked);
	lockedRef.current = locked;

	// Sort the collected sessions by the active rank, with two visibility
	// courtesies: a new order that only permutes the visible page is skipped
	// there (see below), and while a tile is being typed in it keeps the slot
	// it currently occupies on screen.
	const resort = useCallback(() => {
		const r = rankRef.current;
		const next = [...sessionsRef.current];
		// Stable sort; V8's stable sort keeps equal-rank ties in encounter order.
		next.sort(
			(a, b) =>
				(r.get(a.task.id) ?? Number.MAX_SAFE_INTEGER) -
				(r.get(b.task.id) ?? Number.MAX_SAFE_INTEGER),
		);
		setTiles((prev) => {
			// If the new order only permutes tiles already on the visible page,
			// keep that page's arrangement: swapping terminals the user can
			// already see gains nothing and yanks the one they're reading. The
			// page re-orders only when its membership changes (a tile from
			// another page earns a visible slot, or one of its own dies).
			// Off-page tiles always take the new order, that move is invisible.
			const start = pageRef.current * pageSizeRef.current;
			const prevWin = prev.slice(start, start + pageSizeRef.current);
			const nextWin = next.slice(start, start + pageSizeRef.current);
			const sameSet =
				prevWin.length === nextWin.length &&
				prevWin.every((p) => nextWin.some((n) => n.task.id === p.task.id));
			if (sameSet && prevWin.length > 0) {
				// Keep the on-screen arrangement but take next's tile objects,
				// which carry the freshly fetched task DTOs and session lists.
				const fresh = new Map(nextWin.map((t) => [t.task.id, t]));
				const kept = prevWin.map((t) => fresh.get(t.task.id) ?? t);
				next.splice(start, kept.length, ...kept);
			} else {
				const focused = lockedRef.current ? null : focusedRef.current;
				if (focused) {
					const cur = prev.findIndex((t) => t.task.id === focused);
					const pinned = next.find((t) => t.task.id === focused);
					if (cur >= 0 && pinned) {
						next.splice(next.indexOf(pinned), 1);
						next.splice(Math.min(cur, next.length), 0, pinned);
					}
				}
			}
			// Keep the previous array when nothing moved so downstream renders
			// (and their terminals) see a stable identity.
			if (prev.length === next.length && prev.every((t, i) => t === next[i])) return prev;
			return next;
		});
	}, []);

	// Re-sort when the sidebar order changes (only matters unlocked) or the
	// lock flips off and the live order takes over again. rankRef is synced
	// here (not at render time) so the effect legitimately depends on rank.
	useEffect(() => {
		rankRef.current = rank;
		resort();
	}, [rank, resort]);

	// Sessions announce themselves, so this listens instead of polling. Both spawn
	// paths broadcast taskUpdated and a dying PTY broadcasts ptyExit — including from
	// a box, whose events the host forwards — so a timer could never learn anything
	// first. It could only cost: listForTask is routed per task, so for box-owned
	// tasks every pass was one SSH round-trip PER TASK, and the old 2.5s tick issued
	// them in a serial await chain that could outlast its own interval.
	useEffect(() => {
		let cancelled = false;
		let inFlight = false;
		const refresh = async (): Promise<void> => {
			if (inFlight) return; // a slow box must not let passes pile up on each other
			inFlight = true;
			try {
				const perTask = await Promise.all(
					tasksRef.current.map(async (task) => ({
						task,
						sessions: await window.ateam.pty.listForTask(task.id),
					})),
				);
				if (cancelled) return;
				// listForTask hands sessions back latest-first; reverse so the tabs
				// read oldest to newest, exactly as they do in the task panel.
				sessionsRef.current = perTask
					.filter(({ sessions }) => sessions.length > 0)
					.map(({ task, sessions }) => ({ task, sessions: [...sessions].reverse() }));
				resort();
			} finally {
				inFlight = false;
			}
		};
		void refresh();
		const offUpdated = window.ateam.events.onTaskUpdated(() => void refresh());
		const offExit = window.ateam.pty.onExit(() => void refresh());
		return () => {
			cancelled = true;
			offUpdated();
			offExit();
		};
	}, [resort]);

	if (tiles.length === 0) {
		return (
			<div className="mc" data-layout={layout}>
				<div className="empty">
					No live agents yet.
					<br />
					Launch agents from the Board to watch them work side by side here.
				</div>
			</div>
		);
	}

	const visible = tiles.slice(clampedPage * pageSize, clampedPage * pageSize + pageSize);
	return (
		<div className="mc-wrap">
			{/* Keyed by page: flipping remounts the grid, and TerminalView replays
			    its ring-buffer snapshot on mount, so a page flip is a clean swap.
			    The slide follows the flip direction, a "perfect scroll" to the
			    next set of terminals. */}
			<motion.div
				key={clampedPage}
				className="mc"
				data-layout={layout}
				initial={dirRef.current === 0 ? false : { y: dirRef.current * 32, opacity: 0.3 }}
				animate={{ y: 0, opacity: 1 }}
				transition={springy}
			>
				{visible.map(({ task, sessions }) => {
					const shown = activeTerminal(sessions, shownByTask[task.id] ?? null);
					if (!shown) return null; // a task with no live session is not a tile
					const tabs = sessionTabs(sessions, agents);
					return (
						// biome-ignore lint/a11y/noStaticElementInteractions: focus/blur only observe where focus is; the tile itself isn't interactive
						<div
							key={task.id}
							className="tile"
							// React's onFocus/onBlur bubble (focusin/focusout), so these fire
							// when the xterm textarea inside the tile gains/loses focus.
							onFocus={() => {
								focusedRef.current = task.id;
							}}
							onBlur={(e) => {
								// Ignore focus moving within the same tile (e.g. from the bar's
								// button to the terminal). Once focus truly leaves, the pin is
								// released: if the pin was holding the tile away from an
								// off-page slot it now moves there (an in-page permutation
								// alone is skipped by resort anyway).
								if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
								if (focusedRef.current !== task.id) return;
								focusedRef.current = null;
								resort();
							}}
						>
							<div className="bar">
								<span>{task.name}</span>
								<span className="muted">· {task.branch}</span>
								<span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
									{task.agentStatus && <span className={`tstatus ${task.agentStatus}`} />}
									<IconButton
										icon={Maximize2}
										label="Expand to full width"
										size={13}
										onClick={() => onExpand(task, shown)}
									/>
								</span>
							</div>
							{/* Only worth the row when there is a choice to make. */}
							{tabs.length > 1 && (
								<div className="mc-tabs" role="tablist" aria-label={`${task.name} sessions`}>
									{tabs.map(({ session, label }) => (
										<button
											key={session.terminalId}
											type="button"
											role="tab"
											aria-selected={session.terminalId === shown}
											className={`mc-tab ${session.terminalId === shown ? "active" : ""}`}
											title={label}
											onClick={() =>
												setShownByTask((m) => ({ ...m, [task.id]: session.terminalId }))
											}
										>
											{label}
										</button>
									))}
								</div>
							)}
							<TerminalView terminalId={shown} />
						</div>
					);
				})}
			</motion.div>
			{pageCount > 1 && (
				<div className="mcpager">
					<IconButton
						icon={ChevronUp}
						label="Previous terminals"
						shortcut="⌘⌥↑"
						size={14}
						disabled={clampedPage === 0}
						onClick={() => flip(-1)}
					/>
					<span className="count">
						{clampedPage + 1}/{pageCount}
					</span>
					<IconButton
						icon={ChevronDown}
						label="Next terminals"
						shortcut="⌘⌥↓"
						size={14}
						disabled={clampedPage === pageCount - 1}
						onClick={() => flip(1)}
					/>
				</div>
			)}
		</div>
	);
}
