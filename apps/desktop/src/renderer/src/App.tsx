import type {
	AgentDTO,
	BoxWake,
	ConnectionDTO,
	ConnectStep,
	DiffResultDTO,
	GithubIssueDTO,
	KanbanColumn,
	LoopDTO,
	ProjectDTO,
	SessionDTO,
	SessionHitDTO,
	TaskDTO,
	TaskTriage,
} from "@ateam/protocol";
import {
	boxSupports,
	describeMergeResult,
	FEATURE_MIN_VERSION,
	PROTOCOL_VERSION,
	TASK_REMOVING_ERROR,
	wakeMachineName,
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
	CircleAlert,
	Columns2,
	Copy,
	ExternalLink,
	FolderPlus,
	GitBranch,
	GitCommitVertical,
	GitMerge,
	GitPullRequest,
	Globe,
	Grid3x2,
	History,
	Hourglass,
	LayoutDashboard,
	LayoutGrid,
	LayoutPanelLeft,
	Maximize2,
	Minimize2,
	Monitor,
	PanelLeft,
	PanelRight,
	Play,
	Plus,
	RefreshCw,
	Repeat,
	RotateCw,
	Rows2,
	Server,
	Settings,
	SquareTerminal,
	Trash2,
	X,
} from "lucide-react";
import { motion, Reorder } from "motion/react";
import {
	type CSSProperties,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { byLatestActivity } from "../../shared/recency";
import { SessionGlyphs, SessionIcon } from "./components/AgentIcon";
import { ChangesList, DiffStat } from "./components/Changes";
import { CleanupDialog } from "./components/CleanupDialog";
import { ConnectSteps } from "./components/ConnectSteps";
import { FileDiffView } from "./components/FileDiffView";
import { GithubIssueCard, GithubIssuePanel, NewIssueDialog } from "./components/GithubIssues";
import { IconButton } from "./components/IconButton";
import { LeadChat } from "./components/LeadChat";
import { LoopForm, LoopsPanel } from "./components/LoopsPanel";
import { Menu } from "./components/Menu";
import { PageFrame } from "./components/PageFrame";
import { PanelRightFilled } from "./components/PanelRightFilled";
import { PromptComposer } from "./components/PromptComposer";
import { QuestionCard } from "./components/QuestionCard";
import { RailTile } from "./components/RailTile";
import { SettingsPanel } from "./components/SettingsPanel";
import { TaskSearch } from "./components/TaskSearch";
import { TerminalView } from "./components/Terminal";
import { TooltipProvider } from "./components/ui/tooltip";
import { usePrompt } from "./components/usePrompt";
import { VscodeLogo } from "./components/VscodeLogo";
import { bestMcLayout, MC_PAGE_SIZE, type McChoice, type McLayout } from "./mc-layout";
import { activeTerminal, sessionTabs, taskGlyphs } from "./session-tabs";
import { matchesTagQuery, tagsFor, taskIcon } from "./task-tags";
import { byWhatsNext, relativeAge, waitingLabel, waitState } from "./triage-order";
import {
	type Alias,
	aliasLabel,
	type EngineMember,
	type UnifiedProject,
	unifyProjects,
} from "./unify";
import { useGithubIssues } from "./useGithubIssues";

const COLUMNS: { key: KanbanColumn; label: string }[] = [
	{ key: "todo", label: "Backlog" },
	{ key: "running", label: "In Progress" },
	{ key: "needs_attention", label: "Needs You" },
	{ key: "review", label: "Review" },
	{ key: "merged", label: "Done" },
];

// ---- sidebar task ordering ----
type TaskSortMode = "next" | "status" | "updated" | "custom";

// The topbar's Mission Control layout buttons, in the order they sit.
const MC_LAYOUTS = [
	["grid", LayoutGrid, "Grid"],
	["grid3x2", Grid3x2, "3x2 grid"],
	["main", LayoutPanelLeft, "Main + side"],
	["split", Columns2, "Split"],
	["stack", Rows2, "Stack"],
] as const;
const mcLayoutLabel = (l: McLayout) => MC_LAYOUTS.find(([mode]) => mode === l)?.[2] ?? l;

// A saved layout, or null when unset or naming one that no longer exists.
function storedMcLayout(key: string): McLayout | null {
	const v = localStorage.getItem(key);
	return v && v in MC_PAGE_SIZE ? (v as McLayout) : null;
}
// A saved choice: a layout or "auto".
function storedMcChoice(key: string): McChoice | null {
	return localStorage.getItem(key) === "auto" ? "auto" : storedMcLayout(key);
}

// dataTransfer type a tile's bar carries while dragged, so a tile only lights
// up as a drop target for another tile, never for a file dragged in from Finder
// (that drop belongs to the terminal, which types the path).
const MC_TILE_MIME = "application/x-ateam-tile";
// How long a dragged tile is held over the grid's top or bottom edge before
// the page flips.
const FLIP_HOLD_MS = 500;

// Whether a drag carries files from Finder (not a tile, not dragged text).
const draggingFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");

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
// The Lead sidebar on the right: floor, default, and cap as a share of the
// window. The cap is lower than the left one's so that with both open the board
// keeps some room; index.css repeats it (min(var(--lead-w), 40%)).
const MIN_LEAD_W = 320;
const DEFAULT_LEAD_W = 400;
const MAX_LEAD_SHARE = 0.4;

/**
 * Drag a sidebar's edge to resize it. `dir` is 1 when dragging right widens it
 * (the left sidebar) and -1 when dragging left does (the Lead's, on the right).
 * Clamped to [min, share of the window] while dragging, saved under `key` when
 * the drag ends.
 */
function dragWidth(
	e: ReactMouseEvent,
	opts: {
		from: number;
		dir: 1 | -1;
		min: number;
		share: number;
		key: string;
		set: (w: number) => void;
	},
) {
	e.preventDefault();
	const startX = e.clientX;
	let latest = opts.from;
	const onMove = (ev: MouseEvent) => {
		const max = Math.round(window.innerWidth * opts.share);
		latest = Math.min(max, Math.max(opts.min, opts.from + opts.dir * (ev.clientX - startX)));
		opts.set(latest);
	};
	const onUp = () => {
		window.removeEventListener("mousemove", onMove);
		window.removeEventListener("mouseup", onUp);
		document.body.style.cursor = "";
		document.body.style.userSelect = "";
		localStorage.setItem(opts.key, String(latest));
	};
	window.addEventListener("mousemove", onMove);
	window.addEventListener("mouseup", onUp);
	// Keep the resize cursor and suppress text selection for the whole drag.
	document.body.style.cursor = "col-resize";
	document.body.style.userSelect = "none";
}

// Where collapsing a focused task takes you — it's whatever view the task was
// opened over, so the tooltip has to name that view, not the board.
type View = "board" | "mission" | "loops" | "settings" | "lead";

const FOCUS_COLLAPSE_LABEL: Record<View, string> = {
	board: "Show beside the board",
	lead: "Back to the Lead",
	mission: "Back to Mission Control",
	loops: "Back to Loops",
	settings: "Back to Settings",
};

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
	// alias → why the box didn't come up when the app connected to it by itself.
	const [connFailures, setConnFailures] = useState<Record<string, string>>({});
	// alias → the wire contract the held engine actually speaks. A box on a different
	// one is held anyway now, so this is what tells the user which box is skewed.
	const [envProtocol, setEnvProtocol] = useState<Record<string, number>>({});
	// Whether this build can upgrade a box at all. False in dev, where an update
	// would install the latest RELEASE and leave a box running main's protocol
	// still behind — a minute of work that changes nothing.
	const [canUpdateBoxes, setCanUpdateBoxes] = useState(false);
	// Which agents each connected engine actually has installed (its system:hello
	// agents), keyed by alias ("local" for this Mac). Drives per-environment agent
	// availability in the composer — you can only pick an agent the box really has.
	const [envAgents, setEnvAgents] = useState<Record<string, string[]>>({});
	// The boxes whose engine is held right now; null until first read, which counts
	// as none: a box task's panel must not mount (and resume its agent into a
	// refusal) before the app knows its box is there. A box whose projects are on
	// the board but isn't in here is served from its last-seen board
	// (main/offline.ts): its cards show, its engine can't be reached.
	const [heldAliases, setHeldAliases] = useState<Set<string> | null>(null);
	// The active repo's `origin` remote URL (null = local-only). A task can go remote
	// only if there's a remote to clone the project from onto the box.
	const [activeRepoRemote, setActiveRepoRemote] = useState<string | null>(null);
	const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
	const [tasksByProject, setTasksByProject] = useState<Record<string, TaskDTO[]>>({});
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
	const [selectedIssue, setSelectedIssue] = useState<GithubIssueDTO | null>(null);
	const [composerIssue, setComposerIssue] = useState<GithubIssueDTO | null>(null);
	// Files dropped on a project in the sidebar, attached to the composer it opens.
	const [composerFiles, setComposerFiles] = useState<string[]>([]);
	// The project card a file is being dragged over, so its row can light up.
	const [dropCardKey, setDropCardKey] = useState<string | null>(null);
	const [newIssueOpen, setNewIssueOpen] = useState(false);
	const [agents, setAgents] = useState<AgentDTO[]>([]);
	const [view, setView] = useState<View>("board");
	// Layout is per project: one project may run twice the terminals of another.
	// Read during render, not synced in an effect, so switching projects never
	// paints a frame of the previous project's layout (which would also flick
	// the 3x2 rail). A project never set falls back to the old app-wide choice,
	// and failing that to Auto.
	const [mcLayoutSet, setMcLayoutSet] = useState<Record<string, McChoice>>({});
	const mcChoice: McChoice =
		(activeProjectId &&
			(mcLayoutSet[activeProjectId] ?? storedMcChoice(`ateam.mcLayout.${activeProjectId}`))) ||
		storedMcLayout("ateam.mcLayout") ||
		"auto";
	const setMcLayout = (l: McChoice) => {
		if (!activeProjectId) return;
		localStorage.setItem(`ateam.mcLayout.${activeProjectId}`, l);
		setMcLayoutSet((m) => ({ ...m, [activeProjectId]: l }));
	};
	// The layout Auto last fitted for the project, kept so the grid reopens in it
	// (the 3x2's sidebar rail included) until the fresh count says otherwise.
	const [mcFitSet, setMcFitSet] = useState<Record<string, McLayout>>({});
	const mcFit =
		(activeProjectId &&
			(mcFitSet[activeProjectId] ?? storedMcLayout(`ateam.mcFit.${activeProjectId}`))) ||
		"grid";
	const mcLayout: McLayout = mcChoice === "auto" ? mcFit : mcChoice;
	// Auto fits when Mission Control opens, never while it is up: a refit
	// resizes every terminal on the grid (each agent redraws), re-pages the tiles
	// and, into or out of the 3x2, moves the sidebar, none of which an agent
	// starting or quitting should do under your cursor. Opening sets the fit
	// pending and the open grid's tile count clears it (see reorderMission).
	const [mcFitPending, setMcFitPending] = useState(false);
	// How many tiles the open grid has; null until it reports, after opening.
	const [mcTileCount, setMcTileCount] = useState<number | null>(null);
	// Fit to this many tiles. A grid with none yet stays pending, so the first
	// tiles to arrive are what it fits.
	const fitMission = (tiles: number) => {
		if (!activeProjectId || tiles === 0) return;
		setMcFitPending(false);
		const l = bestMcLayout(tiles);
		localStorage.setItem(`ateam.mcFit.${activeProjectId}`, l);
		setMcFitSet((m) => ({ ...m, [activeProjectId]: l }));
	};
	// Bumped by the Sync button: Mission Control re-sorts its tiles to the
	// sidebar's order once, then holds still again (see mcOrder).
	const [mcSyncSeq, setMcSyncSeq] = useState(0);
	// Which work Mission Control tiles: the tasks (the sidebar's TASKS list) or
	// the loops' own tasks (its LOOPS list), never both on one grid.
	const [mcMode, setMcModeState] = useState<"tasks" | "loops">(() =>
		localStorage.getItem("ateam.mcMode") === "loops" ? "loops" : "tasks",
	);
	const setMcMode = (m: "tasks" | "loops") => {
		localStorage.setItem("ateam.mcMode", m);
		setMcModeState(m);
	};
	// The Mission Control tile with the white edge: set by clicking a task in the
	// sidebar or by clicking into a tile. A sidebar click also sends a jump (seq
	// makes a repeat click on the same task a fresh request) so the grid pages to
	// that tile and focuses its terminal.
	const [mcHighlightId, setMcHighlightId] = useState<string | null>(null);
	const [mcJump, setMcJump] = useState<{ id: string; seq: number } | null>(null);
	const [panelMode, setPanelMode] = useState<"side" | "full">("side");
	const [projectsCollapsed, setProjectsCollapsed] = useState(false);
	const [tasksCollapsed, setTasksCollapsed] = useState(false);
	const [loopsCollapsed, setLoopsCollapsed] = useState(false);
	// The open loop dialog: `editId: null` creates, an id edits that loop. Owned
	// here, not by LoopsPanel, so the sidebar's "+" opens it over any view, the
	// way the task composer opens.
	const [loopDialog, setLoopDialog] = useState<{ editId: string | null } | null>(null);
	// Every engine's loops (merged), for the sidebar LOOPS section and the Loops
	// tab (both scoped to the selected project). Each loop owns one persistent
	// task (loop.taskId); those tasks show under LOOPS.
	const [loops, setLoops] = useState<LoopDTO[]>([]);
	// A mutation's return and the push event both carry ONE engine's loops, so
	// every refresh re-lists the union.
	const refreshLoops = useCallback(() => void window.ateam.loops.list().then(setLoops), []);
	// Collapsing the sidebar is only ever the user's call, in every view and
	// layout. Mission Control's 3x2 grid used to tuck it away for wider tiles;
	// the sidebar vanishing on its own cost more than the extra columns gave.
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
	const startSidebarResize = (e: ReactMouseEvent) =>
		dragWidth(e, {
			from: sidebarWidth,
			dir: 1,
			min: MIN_SIDEBAR_W,
			share: 0.5,
			key: "ateam.sidebarWidth",
			set: setSidebarWidth,
		});
	// The Lead as a sidebar on the right, the mirror of this one: a full-height
	// column with a draggable width, still open after a restart. The Lead tab
	// keeps the full-width chat and hides the sidebar, so there is one copy.
	const [leadSide, setLeadSideState] = useState(
		() => localStorage.getItem("ateam.leadSide") === "1",
	);
	const setLeadSide = (on: boolean) => {
		localStorage.setItem("ateam.leadSide", on ? "1" : "0");
		setLeadSideState(on);
	};
	const [leadWidth, setLeadWidth] = useState(() => {
		const saved = Number(localStorage.getItem("ateam.leadWidth"));
		return Number.isFinite(saved) && saved >= MIN_LEAD_W ? saved : DEFAULT_LEAD_W;
	});
	const startLeadResize = (e: ReactMouseEvent) =>
		dragWidth(e, {
			from: leadWidth,
			dir: -1,
			min: MIN_LEAD_W,
			share: MAX_LEAD_SHARE,
			key: "ateam.leadWidth",
			set: setLeadWidth,
		});
	const leadShown = leadSide && view !== "lead";
	const [taskSort, setTaskSortState] = useState<TaskSortMode>(
		// Default: last updated first. The list you scan is the list you just
		// touched, so the freshest work sits at the top without a menu trip.
		() => (localStorage.getItem("ateam.taskSort") as TaskSortMode) || "updated",
	);
	const [customOrder, setCustomOrder] = useState<string[]>([]);
	const [cleanupOpen, setCleanupOpen] = useState(false);
	const [archivedCount, setArchivedCount] = useState(0);
	// Bumped whenever a card leaves a board, which is also what an archive looks
	// like from here, so the archived count on Clean up follows the sweep.
	const [archivedTick, setArchivedTick] = useState(0);
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
			const msg = e instanceof Error ? e.message : String(e);
			// The engine refusing to launch into a task mid-delete: expected when
			// the delete's own kill makes the open panel auto-resume its agent.
			if (msg.includes(TASK_REMOVING_ERROR)) return;
			setError(msg);
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
		// Loops for the sidebar section and the Loops tab. Always re-list on the
		// push event — the event payload carries ONE engine's loops, the UI wants
		// the union.
		refreshLoops();
		const offLoops = window.ateam.loops.onUpdated(refreshLoops);
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
			setArchivedTick((n) => n + 1);
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
	}, [loadProjects, refreshLoops]);

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
			refreshLoops();
		});
	}, [loadProjects, refreshLoops]);

	// The ~/.ssh/config box list for the composer's "Run on" picker + each connected
	// engine's installed agents, kept fresh as boxes connect/disconnect.
	useEffect(() => {
		const load = () => {
			void window.ateamHost.list().then(setConnections);
			void window.ateamHost.failures().then(setConnFailures);
			void window.ateamHost.canUpdateBoxes().then(setCanUpdateBoxes);
			void window.ateamHost.connected().then((list) => {
				const map: Record<string, string[]> = {};
				const wire: Record<string, number> = {};
				for (const s of list) {
					map[s.alias ?? "local"] = s.info.agents;
					wire[s.alias ?? "local"] = s.info.protocolVersion;
				}
				setEnvAgents(map);
				setEnvProtocol(wire);
				setHeldAliases(new Set(list.flatMap((s) => (s.alias ? [s.alias] : []))));
			});
		};
		load();
		return window.ateamHost.onConnectionsChanged(load);
	}, []);

	// The steps of waking and reaching each box a provider puts to sleep, while a
	// connect the user asked for runs (empty once it is over).
	const [connectSteps, setConnectSteps] = useState<Record<string, ConnectStep[]>>({});
	useEffect(
		() =>
			window.ateamHost.onConnectProgress(({ alias, steps }) =>
				setConnectSteps((cur) => ({ ...cur, [alias]: steps })),
			),
		[],
	);
	// The box a task is being set up on, so the toast can show its steps.
	const [provisioning, setProvisioning] = useState<string | null>(null);

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
	const issueRepository =
		activeCard?.githubOwner && activeCard.githubName
			? `${activeCard.githubOwner}/${activeCard.githubName}`.toLowerCase()
			: null;
	const issueSync = useGithubIssues(view === "board" ? issueRepository : null);
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
	// The box a task is on when that box isn't held (its card is from the box's
	// last-seen board), else null.
	const offlineAliasOf = useCallback(
		(task: TaskDTO): string | null => {
			const alias = originOf(task.projectId);
			return alias && !heldAliases?.has(alias) ? alias : null;
		},
		[originOf, heldAliases],
	);
	// The box being woken because a task on it was opened. A ref guards against a
	// second wake while one runs; the state drives the panel.
	const [wakingAlias, setWakingAlias] = useState<string | null>(null);
	const wakingRef = useRef<string | null>(null);
	// Opening a task on a box that isn't held is the user asking for that box, the
	// same intent as starting a task on it, so it is woken the same way. Only an
	// open does this: a selection restored on launch must never wake a box.
	const wakeBox = useCallback(async (alias: string) => {
		if (wakingRef.current === alias) return;
		wakingRef.current = alias;
		setWakingAlias(alias);
		try {
			await window.ateamHost.connect(alias, { wake: true });
		} catch (e) {
			setError(
				`Couldn't reach ${aliasLabel(alias)}: ${e instanceof Error ? e.message : String(e)}`,
			);
		} finally {
			wakingRef.current = null;
			setWakingAlias(null);
		}
	}, []);
	const wakeIfOffline = (task: TaskDTO | undefined) => {
		const alias = task ? offlineAliasOf(task) : null;
		if (alias) void wakeBox(alias);
	};

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
	// Adding is the user's action, so a box a provider puts to sleep is woken for it;
	// `wake` (null for none) is saved along with the box once it answers. Adding a
	// box that is already listed is how its provider is changed.
	const addTailscaleBox = useCallback(async (endpoint: string, wake: BoxWake | null) => {
		await window.ateamHost.connect(endpoint, { wake: true, binding: wake });
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
	// Install a coding agent's CLI on whichever machine the chosen environment is:
	// this Mac or a box, one path for both. Routed by that engine's projectId —
	// the same key that lands a task there (unify.ts) — because the engine doing
	// the installing IS the machine that has to end up with the binary.
	const installAgentOn = useCallback(
		async (alias: Alias, agentId: string) => {
			const member = activeMembers.find((m) => m.alias === alias);
			if (!member) throw new Error("Pick an environment that has this repo first.");
			const res = await window.ateam.agents.install({ projectId: member.projectId, agentId });
			// Take the engine's own verdict rather than waiting for the next
			// handshake: it just re-resolved its PATH, so this is the freshest
			// answer anyone has, and it's what un-greys the row.
			if (res.available) {
				const key = alias ?? "local";
				setEnvAgents((prev) => ({
					...prev,
					[key]: [...new Set([...(prev[key] ?? []), agentId])],
				}));
				if (alias === null) void window.ateam.agents.list().then(setAgents);
			}
			return res;
		},
		[activeMembers],
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
				// A box a provider wakes goes by its machine name there, as on the phone;
				// its address moves to the row's subtitle.
				label: wakeMachineName(c.wake) ?? c.alias,
				disabled: !memberAliases.has(c.alias) && !canRemote,
				transport: c.transport,
				// `known` is only set by a successful connect, so a config alias we've
				// never reached is one the engine has probably never been installed on.
				needsSetup: !c.known,
				asleep: c.asleep,
				wake: c.wake ?? null,
				// Set only for a connect the app made on its own, where there was no
				// caller to show the error to — an upgrade that failed reads as an
				// ordinary offline box without it.
				error: connFailures[c.alias],
				// Held, but not on this app's wire contract. Only for a box we actually
				// hold: an unreachable one has no version to report, and saying nothing
				// is better than guessing from the last one we saw.
				skew:
					envProtocol[c.alias] !== undefined && envProtocol[c.alias] !== PROTOCOL_VERSION
						? envProtocol[c.alias]
						: undefined,
				// Can THIS app update THIS box: a dev build can't update any box, and no
				// build can update one reachable only over its Tailscale endpoint.
				updatable: canUpdateBoxes && c.transport !== "ws",
			})),
		];
	}, [
		connections,
		canRemote,
		hasLocalMember,
		activeMembers,
		connFailures,
		envProtocol,
		canUpdateBoxes,
	]);

	// Every loaded task, for the Lead chat to name and open the ones it touches.
	const allTasks = useMemo(() => Object.values(tasksByProject).flat(), [tasksByProject]);

	// The active card's board unions tasks from every engine that has the repo.
	const activeTasks = activeCard
		? activeMembers.flatMap((m) => tasksByProject[m.projectId] ?? [])
		: activeProjectId
			? (tasksByProject[activeProjectId] ?? [])
			: [];
	// Archived tasks of the project Clean up opens on, which is where they are
	// shown and brought back.
	// biome-ignore lint/correctness/useExhaustiveDependencies: archivedTick is the trigger, not a value the body reads: it re-counts after a card leaves the board.
	useEffect(() => {
		if (!activeProjectId) return setArchivedCount(0);
		let stale = false;
		// An engine older than v18 has no archive: it rejects, and counts as none.
		void window.ateam.tasks
			.listArchived(activeProjectId)
			.catch(() => [])
			.then((list) => {
				if (!stale) setArchivedCount(list.length);
			});
		return () => {
			stale = true;
		};
	}, [activeProjectId, archivedTick]);
	const linkedIssues = new Set(
		activeTasks.flatMap((task) => (task.issueUrl ? [task.issueUrl.toLowerCase()] : [])),
	);
	const backlogIssues = issueSync.issues.filter(
		(issue) => !linkedIssues.has(issue.url.toLowerCase()),
	);
	const visibleIssue =
		!selectedTaskId && selectedIssue
			? (backlogIssues.find((issue) => issue.url === selectedIssue.url) ?? null)
			: null;
	const selectedTask = activeTasks.find((t) => t.id === selectedTaskId) ?? null;
	// Its box isn't held, so it has no terminal or worktree to show: the panel says
	// so and wakes it instead of mounting a TaskPanel whose every call is refused.
	const selectedOffline = selectedTask ? offlineAliasOf(selectedTask) : null;
	// Mission Control's grid is on screen (not covered by a full-width task).
	// There the sidebar lights the highlighted tile's task instead of the
	// selection, since a click there highlights rather than opens.
	const mcGridShown = view === "mission" && !(selectedTask && panelMode === "full");
	const sidebarSelectedId = mcGridShown ? mcHighlightId : selectedTaskId;
	// Opening Mission Control, which is when Auto fits: switching to it, or to
	// another project's or mode's grid while on it. Coming back from a tile
	// expanded full width is not an opening (the view never changed), even
	// though the grid remounts. Settled during render, like the rail.
	const mcGridKey = `${activeCard?.key ?? activeProjectId}:${mcMode}`;
	const mcOpenKey = view === "mission" ? mcGridKey : null;
	const [mcOpenSeen, setMcOpenSeen] = useState(mcOpenKey);
	if (mcOpenSeen !== mcOpenKey) {
		setMcOpenSeen(mcOpenKey);
		setMcTileCount(null);
		if (mcOpenKey) setMcFitPending(true);
	}
	// Auto fitted when the grid opened, and agents may have started or quit
	// since. That is shown on the Auto button, not acted on: one click re-fits.
	const mcRefit =
		mcChoice === "auto" && mcGridShown && !mcFitPending && mcTileCount
			? bestMcLayout(mcTileCount)
			: null;
	const mcRefitDue = mcRefit !== null && mcRefit !== mcLayout;
	// The Auto button: on the grid it fits what is there now; from anywhere
	// else the opening does it.
	const chooseAutoLayout = () => {
		setMcLayout("auto");
		if (mcGridShown && mcTileCount) fitMission(mcTileCount);
		else setMcFitPending(true);
		goToView("mission");
	};
	// Loops of the active repo card (whichever engine holds them), and the task
	// each one owns. Loop-owned tasks show under LOOPS, not again under TASKS
	// (they stay on the board — it's the status surface).
	const activeLoops = useMemo(() => {
		const memberIds = new Set(activeMembers.map((m) => m.projectId));
		return loops.filter((l) => l.projectId != null && memberIds.has(l.projectId));
	}, [loops, activeMembers]);
	// The loop an edit dialog targets. If it leaves scope (deleted elsewhere, or
	// the project switched) the dialog closes rather than edit a loop that's gone.
	const editingLoop = loopDialog?.editId
		? (activeLoops.find((l) => l.id === loopDialog.editId) ?? null)
		: null;
	useEffect(() => {
		if (loopDialog?.editId && !editingLoop) setLoopDialog(null);
	}, [loopDialog, editingLoop]);
	// Sidebar LOOPS rows and the Loops tab: the active (enabled) loops first,
	// paused ones after, so what is actually running is always at the top.
	const sortedLoops = useMemo(
		() => [...activeLoops].sort((a, b) => Number(b.enabled) - Number(a.enabled)),
		[activeLoops],
	);
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
			list.sort(byLatestActivity);
		} else {
			const rank = new Map(customOrder.map((id, i) => [id, i]));
			list.sort(
				(a, b) =>
					(rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
			);
		}
		return list;
	}, [sidebarTasks, taskSort, customOrder]);
	// Stable identity, so the Mission Control order memoized on it doesn't
	// recompute on every App render.
	const sidebarOrderIds = useMemo(
		() => orderedSidebarTasks.map((t) => t.id),
		[orderedSidebarTasks],
	);
	// Mission Control's own tile order, per project, independent of the
	// sidebar's: status changes reorder the list, never the tiles. It records
	// the tiles as Mission Control last laid them out; the first visit seeds it
	// from the sidebar, new tiles join the end, a tile drag swaps two, and only
	// Sync re-applies the sidebar's order. Read during render (like mcLayout) so
	// a project switch mounts Mission Control with that project's order, not a
	// frame of the last one's.
	const [mcOrderSet, setMcOrderSet] = useState<Record<string, string[]>>({});
	const mcOrder = useMemo(() => {
		if (!activeProjectId) return [];
		const set = mcOrderSet[activeProjectId];
		if (set) return set;
		try {
			return JSON.parse(
				localStorage.getItem(`ateam.mcOrder.${activeProjectId}`) ?? "[]",
			) as string[];
		} catch {
			return [];
		}
	}, [activeProjectId, mcOrderSet]);
	// Loops mode follows the sidebar's LOOPS list the way Tasks mode follows TASKS.
	const loopOrderIds = useMemo(
		() => sortedLoops.flatMap((l) => (l.taskId ? [l.taskId] : [])),
		[sortedLoops],
	);
	const missionTasks = useMemo(
		() =>
			mcMode === "loops"
				? activeTasks.filter((t) => loopTaskIds.has(t.id))
				: activeTasks.filter((t) => !loopTaskIds.has(t.id)),
		[mcMode, activeTasks, loopTaskIds],
	);
	const missionBaseIds = mcMode === "loops" ? loopOrderIds : sidebarOrderIds;
	// The rank Mission Control lays tiles out by when it mounts or syncs: its
	// saved order, then tasks it has never placed in the sidebar's order. Both
	// modes share the saved order; the other mode's ids sit in it tile-less.
	const missionOrderIds = useMemo(() => {
		const known = new Set(mcOrder);
		return [...mcOrder, ...missionBaseIds.filter((id) => !known.has(id))];
	}, [mcOrder, missionBaseIds]);
	const saveMcOrder = (ids: string[]) => {
		if (!activeProjectId) return;
		setMcOrderSet((m) => ({ ...m, [activeProjectId]: ids }));
		localStorage.setItem(`ateam.mcOrder.${activeProjectId}`, JSON.stringify(ids));
	};
	// Mission Control reports the tiles' order whenever it changes; they lead
	// the saved order and everything else keeps its relative place behind them.
	// The report is also the grid's tile count, which an opening waits on to fit.
	const reorderMission = (tileIds: string[]) => {
		setMcTileCount(tileIds.length);
		if (mcFitPending && mcChoice === "auto") fitMission(tileIds.length);
		const onTiles = new Set(tileIds);
		const next = [...tileIds, ...mcOrder.filter((id) => !onTiles.has(id))];
		if (next.length === mcOrder.length && next.every((id, i) => id === mcOrder[i])) return;
		saveMcOrder(next);
	};
	// Sync: the sidebar's current order replaces Mission Control's. Deleted
	// tasks are dropped here so the saved order doesn't grow forever.
	const syncMission = () => {
		const inBase = new Set(missionBaseIds);
		const live = new Set(activeTasks.map((t) => t.id));
		saveMcOrder([...missionBaseIds, ...mcOrder.filter((id) => !inBase.has(id) && live.has(id))]);
		setMcSyncSeq((s) => s + 1);
	};

	// One box, two jobs, told apart by a leading `#`.
	//
	//   `#bug`   a FILTER — narrows the board and sidebar to bug-tagged work,
	//            which is the whole point of having a cross-cutting axis.
	//   `caret`  a SEARCH — answered in the popover (see TaskSearch), which
	//            lists matching tasks AND the sessions that discussed them.
	//
	// Words used to hide cards too. They no longer do: hiding answers "where is
	// it?" by removing everything else, which is a filter's answer to a search's
	// question, and it cannot show a session at all.
	const query = taskQuery.trim().toLowerCase();
	const tagFilter = query.startsWith("#") ? query : null;
	const matchesQuery = useCallback(
		(t: TaskDTO) => (tagFilter === null ? true : matchesTagQuery(tagFilter, t)),
		[tagFilter],
	);
	// Sidebar and board both honor the tag filter; Mission Control and the
	// selected task deliberately don't (a live agent tile / open panel shouldn't
	// vanish).
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
				view: View;
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
	// From the sidebar → open full width over whichever view you're already in
	// (the focused task covers Board / Mission Control / Loops alike, and closing
	// it lands you back there). From the board → open on the side.
	const openTask = (t: TaskDTO) => {
		setActiveProjectId(t.projectId);
		setSelectedTaskId(t.id);
		markRead(t.id);
		setPanelMode("full");
		wakeIfOffline(t);
	};
	const selectFromBoard = (id: string) => {
		setSelectedTaskId(id);
		markRead(id);
		setPanelMode("side");
		wakeIfOffline(activeTasks.find((t) => t.id === id));
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
	// Clicking the task you're already focused on closes it, revealing the view
	// underneath — the lit tab already tells you which one you'll land on. Only
	// the sidebar toggles: a search hit or a board card means "take me there",
	// never "take me away".
	const toggleTask = (t: TaskDTO) => {
		if (t.id === selectedTaskId && panelMode === "full") {
			setSelectedTaskId(null);
			return;
		}
		// Over the Mission Control grid a sidebar click points at the task's tile
		// (white edge, keyboard focus) rather than covering the grid. A task with
		// no live session has no tile, so Mission Control hands it back and it
		// opens full width as before (see onJumpMissing).
		if (mcGridShown) {
			markRead(t.id);
			setMcHighlightId(t.id);
			setMcJump((j) => ({ id: t.id, seq: (j?.seq ?? 0) + 1 }));
			return;
		}
		openTask(t);
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
	// Collapsing the focused task. Only the Board has somewhere to shrink *to*
	// (its side panel); Mission Control and Loops are single-column, so there
	// collapsing means "back to the view", same as closing.
	const collapseFocus = () => {
		if (view === "board") {
			setPanelMode("side");
			return;
		}
		setSelectedTaskId(null);
		setPanelMode("side");
	};
	// Tabs mean "show me this view". The focused task covers the view it belongs
	// to, so switching tabs — including clicking the lit one — closes it.
	const goToView = (v: View) => {
		if (panelMode === "full") setSelectedTaskId(null);
		setView(v);
	};
	// The menu's Settings… (⌘,) arrives from the main process. Held in a ref so
	// the one subscription always calls the goToView of the latest render.
	const goToViewRef = useRef(goToView);
	goToViewRef.current = goToView;
	useEffect(() => window.ateam.events.onOpenSettings?.(() => goToViewRef.current("settings")), []);
	// A wait's notification was clicked (main/wait-notify.ts): open that task.
	const openTaskRef = useRef(openTask);
	openTaskRef.current = openTask;
	useEffect(() => window.ateam.events.onOpenTask?.((t) => openTaskRef.current(t)), []);

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
		setComposerIssue(null);
		setComposerFiles([]);
		setSelectedIssue(null);
		if (activeProjectId) setComposerOpen(true);
	};

	// Drop files from Finder on a project (row or rail tile) to start a task in it
	// with them attached: switch to the project and open the composer, so the
	// user still writes the prompt and picks the agent before anything launches.
	const projectDropProps = (cardKey: string, projectId: string) => ({
		onDragOver: (e: React.DragEvent) => {
			if (!draggingFiles(e)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
			setDropCardKey(cardKey);
		},
		onDragLeave: (e: React.DragEvent) => {
			// Moving onto the row's own dot or name is not leaving it.
			if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
			setDropCardKey((cur) => (cur === cardKey ? null : cur));
		},
		onDrop: (e: React.DragEvent) => {
			if (!draggingFiles(e)) return;
			e.preventDefault();
			setDropCardKey(null);
			const paths = Array.from(e.dataTransfer.files)
				.map((f) => window.ateam.utils.pathForFile(f))
				.filter(Boolean);
			if (!paths.length) return;
			selectProject(projectId);
			setComposerIssue(null);
			setSelectedIssue(null);
			setComposerFiles(paths);
			setComposerOpen(true);
		},
	});

	const removeProject = (member: EngineMember) =>
		run(async () => {
			const ok = await confirm(
				"Remove project?",
				`Remove "${member.project.name}" from Ateam on ${aliasLabel(member.alias)}? Its task history and loops will be removed from Ateam. Repository files, branches, and worktrees will stay on disk.`,
			);
			if (!ok) return;
			await window.ateam.projects.remove(member.projectId);
			delete viewMemRef.current[member.projectId];
			setSelectedTaskId((cur) =>
				tasksByProject[member.projectId]?.some((t) => t.id === cur) ? null : cur,
			);
			setLoops((prev) => prev.filter((loop) => loop.projectId !== member.projectId));
			await loadProjects();
		});

	// Delete a task (and its worktree) straight from the sidebar. Confirm first,
	// then reuse the same remove + force-fallback flow as the task panel menu.
	// The onTaskRemoved event listener drops the row and clears the selection.
	// Park a task on an outside party from the sidebar, or end the wait. The
	// agent's own path is the `set_waiting` board tool; both meet in the engine.
	const toggleWaiting = (t: TaskDTO) =>
		run(async () => {
			if (t.waitingUntil != null) {
				const ok = await confirm("Stop waiting?", `"${t.name}" goes back to its normal place.`);
				if (!ok) return;
				await window.ateam.tasks.setWaiting(t.id, null);
				return;
			}
			const reason = await ask("Waiting for what?");
			if (!reason) return;
			const daysText = await ask("Check back in how many days?", "5");
			if (daysText == null) return;
			const days = Number(daysText);
			if (!Number.isFinite(days) || days <= 0) throw new Error("Enter a number of days.");
			await window.ateam.tasks.setWaiting(t.id, {
				reason,
				until: Date.now() + days * 86_400_000,
			});
		});
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
			const sourceIssue = composerIssue;
			setComposerOpen(false);
			setComposerIssue(null);
			setComposerFiles([]);
			if (sourceIssue) {
				const existing = activeTasks.find(
					(task) => task.issueUrl?.toLowerCase() === sourceIssue.url.toLowerCase(),
				);
				if (existing) {
					selectFromBoard(existing.id);
					setSelectedIssue(null);
					return;
				}
			}
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
					// Its project is on the board from the box's last-seen board: wake
					// it, and the engine takes over the same ids (host.ts connect).
					if (!heldAliases?.has(input.alias)) {
						setInfo(`Waking ${aliasLabel(input.alias)}…`);
						setProvisioning(input.alias);
						try {
							await window.ateamHost.connect(input.alias, { wake: true });
						} finally {
							setInfo(null);
							setProvisioning(null);
						}
					}
				} else {
					// First task on this box for this repo: it isn't here yet, so clone +
					// register it from the repo's remote, then route the create to it.
					if (!activeRepoRemote) {
						setError("This repo has no git remote to clone onto a box.");
						return;
					}
					setInfo(
						`Setting up ${card.name} on ${composerEnvs.find((e) => e.alias === input.alias)?.label ?? input.alias}…`,
					);
					setProvisioning(input.alias);
					let proj: ProjectDTO;
					try {
						proj = await window.ateamHost.provision(input.alias, { cloneUrl: activeRepoRemote });
					} finally {
						setInfo(null);
						setProvisioning(null);
					}
					// Re-list so the aggregate learns proj.id → this box; then create routes there.
					await loadProjects();
					projectId = proj.id;
				}
			}
			const taskInput = { projectId, name: input.name, agentId: input.agentId };
			let task: TaskDTO;
			let created = true;
			if (sourceIssue) {
				try {
					const result = await window.ateam.tasks.createFromIssue({
						...taskInput,
						issueNumber: sourceIssue.number,
						description: input.prompt,
					});
					task = result.task;
					created = result.created;
				} catch (error) {
					if (/Unknown method/.test(String(error)))
						throw new Error("Update Ateam on the selected box to start tasks from GitHub issues.");
					throw error;
				}
			} else task = await window.ateam.tasks.create(taskInput);
			setSelectedIssue(null);
			// The created task's project is a member of the active card, so its tasks
			// are already unioned into the board once loaded.
			await loadTasks(task.projectId);
			// Land the new task in whatever the user is actually looking at: a
			// task open full-width hands its panel to the new one, the board
			// opens it beside itself, and Mission Control just grows a tile.
			// `panelMode` survives deselection, so "full" only counts while a
			// task is really on screen — otherwise the board would jump to a
			// full-width panel the user never opened.
			if (!(selectedTaskId && panelMode === "full")) setPanelMode("side");
			setSelectedTaskId(task.id);
			// Loops shows only loop-owned tasks, so a new task would land
			// somewhere it can't be seen; every other view keeps its place.
			if (view === "loops") setView("board");
			if (!created) return;
			const { terminalId } = await window.ateam.pty.spawnAgent({
				taskId: task.id,
				agentId: input.agentId,
				yolo: input.yolo,
				prompt: input.prompt || undefined,
				files: input.files.length ? input.files : undefined,
			});
			setTermByTask((m) => ({ ...m, [task.id]: terminalId }));
		});

	// Cleanup reads a shape that changed in v6, so an older box would not degrade
	// here, it would throw inside the dialog's sort. Gate on the OWNING engine, not
	// on whatever box happens to be selected: the dialog runs against one project,
	// and that project lives on exactly one engine. Local is never skewed with
	// itself, so a project on this Mac is always allowed.
	const cleanupBlockedBy = useMemo(() => {
		if (!activeProjectId) return null;
		const owner = activeMembers.find((m) => m.projectId === activeProjectId);
		if (!owner?.alias) return null;
		const version = envProtocol[owner.alias];
		return version !== undefined && !boxSupports("cleanup", version) ? version : null;
	}, [activeProjectId, activeMembers, envProtocol]);

	const cleanup = () => {
		if (activeProjectId && cleanupBlockedBy === null) setCleanupOpen(true);
	};

	return (
		<div
			className={`app ${rail ? "rail" : ""} ${leadShown ? "lead-open" : ""}`}
			style={{ "--sidebar-w": `${sidebarWidth}px`, "--lead-w": `${leadWidth}px` } as CSSProperties}
		>
			<aside className={`sidebar ${rail ? "rail" : ""}`}>
				{/* In rail mode the traffic lights own this strip; the toggle moves
				    below them as the first tile. */}
				<div className="side-top">
					{!rail && (
						<IconButton
							icon={Settings}
							label="Settings"
							shortcut="⌘,"
							active={view === "settings"}
							onClick={() => goToView("settings")}
						/>
					)}
					{!rail && <IconButton icon={PanelLeft} label="Collapse sidebar" onClick={toggleRail} />}
				</div>

				{rail ? (
					// The expanded sidebar's three sections as tile groups, each led
					// by the action its header carries (Add project, New task, New
					// loop), so collapsing the sidebar never takes a way to create
					// something. One provider: gliding down the strip opens each
					// tile's name at once instead of waiting out the delay again.
					<TooltipProvider delayDuration={150} skipDelayDuration={400} disableHoverableContent>
						<RailTile label="Expand sidebar" onClick={toggleRail}>
							<PanelLeft size={16} strokeWidth={1.75} />
						</RailTile>
						<div className="rail-divider" />
						{/* A detached window is one project, so like its expanded header
						    it offers no way to add another. */}
						{!boundProjectId && (
							<RailTile label="Add project" onClick={addProject}>
								<FolderPlus size={16} strokeWidth={1.75} />
							</RailTile>
						)}
						{unifiedProjects.map((card) => {
							const alert = cardAlert(card);
							const primary = card.members.find((m) => m.alias === null) ?? card.members[0];
							if (!primary) return null;
							const active = card.members.some((m) => m.projectId === activeProjectId);
							return (
								<RailTile
									key={card.key}
									label={card.name}
									hint={boundProjectId ? undefined : "Double-click to open in a new window"}
									active={active}
									className={dropCardKey === card.key ? "file-drop" : undefined}
									{...projectDropProps(card.key, primary.projectId)}
									onClick={() => selectProject(primary.projectId)}
									onDoubleClick={
										boundProjectId
											? undefined
											: () => window.ateam.window.openProject(primary.projectId)
									}
								>
									{card.name.charAt(0).toUpperCase()}
									{alert && <span className={`corner pulse ${alert}`} />}
								</RailTile>
							);
						})}
						<div className="rail-divider" />
						<RailTile
							label="New task"
							hint={activeProjectId ? undefined : "Select a project first"}
							onClick={newTask}
							disabled={!activeProjectId}
						>
							<Plus size={16} strokeWidth={1.75} />
						</RailTile>
						{visibleSidebarTasks.map((t) => {
							const Icon = taskIcon(t.name);
							// One tile, one glyph: the first live session, and a count when
							// there are more — the row and the card have room to show them all.
							const [glyph, ...rest] = taskGlyphs(t);
							return (
								<RailTile
									key={t.id}
									label={t.name}
									active={t.id === sidebarSelectedId}
									onClick={() => toggleTask(t)}
								>
									{glyph ? (
										<SessionIcon agentId={glyph} size={16} />
									) : (
										<Icon size={16} strokeWidth={1.75} />
									)}
									{rest.length > 0 && <span className="rail-count">{rest.length + 1}</span>}
									{t.preparing ? (
										<span className="corner preparing" />
									) : (
										t.agentStatus && <span className={`corner ${t.agentStatus}`} />
									)}
								</RailTile>
							);
						})}
						<div className="rail-divider" />
						<RailTile
							label="New loop"
							hint={activeProjectId ? undefined : "Select a project first"}
							onClick={() => setLoopDialog({ editId: null })}
							disabled={!activeProjectId}
						>
							<Plus size={16} strokeWidth={1.75} />
						</RailTile>
						{sortedLoops.map((l) => {
							// Same row as the LOOPS section: the loop's own task, or the
							// Loops tab before its first run.
							const task = l.taskId ? (activeTasks.find((t) => t.id === l.taskId) ?? null) : null;
							return (
								<RailTile
									key={l.id}
									label={l.title}
									hint={l.enabled ? undefined : "Paused"}
									active={task != null && task.id === sidebarSelectedId}
									className={l.enabled ? undefined : "loop-paused"}
									onClick={() => (task ? toggleTask(task) : goToView("loops"))}
								>
									<Repeat size={16} strokeWidth={1.75} />
									{task?.agentStatus && <span className={`corner ${task.agentStatus}`} />}
								</RailTile>
							);
						})}
					</TooltipProvider>
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
							<div className="side-section">
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
								{!projectsCollapsed && (
									<div className="side-list">
										{unifiedProjects.map((card) => {
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
												// Keep the menu beside the row button so its actions don't
												// select or detach the project.
												<div key={card.key} className="proj-row">
													<button
														type="button"
														className={`proj ${active ? "active" : ""} ${dropCardKey === card.key ? "file-drop" : ""}`}
														{...projectDropProps(card.key, primary.projectId)}
														onClick={() => selectProject(primary.projectId)}
														onDoubleClick={() => window.ateam.window.openProject(primary.projectId)}
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
														<Menu
															label={`Actions for ${card.name}`}
															items={[
																{
																	label: "Open in new window",
																	icon: ExternalLink,
																	onClick: () => window.ateam.window.openProject(primary.projectId),
																},
																...card.members.map((member) => ({
																	label: multiEnv
																		? `Remove from ${aliasLabel(member.alias)}…`
																		: "Remove project…",
																	icon: Trash2,
																	danger: true,
																	onClick: () => removeProject(member),
																})),
															]}
														/>
													</span>
												</div>
											);
										})}
									</div>
								)}
							</div>
						)}

						{/* TASKS accordion — active tasks of the selected project */}
						<div className="side-section">
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
										// The section header's icon buttons are 24px (.section-head .iconbtn).
										className="size-6"
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
							{!tasksCollapsed && (
								<div className="side-list">
									{!activeProjectId ? (
										<div className="tree-empty">Select a project</div>
									) : visibleSidebarTasks.length === 0 ? (
										<div className="tree-empty">
											{tagFilter ? "No matching tasks" : "No active tasks"}
										</div>
									) : taskSort === "custom" && !tagFilter ? (
										// Custom order: drag rows up/down; Motion animates the shuffle.
										// Disabled while a tag filter is on — reordering a filtered subset
										// would drop the hidden tasks from the saved order.
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
														offline={offlineAliasOf(t) !== null}
														selected={t.id === sidebarSelectedId}
														onClick={() => toggleTask(t)}
														onDelete={() => deleteTask(t)}
														onWait={() => toggleWaiting(t)}
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
													offline={offlineAliasOf(t) !== null}
													selected={t.id === sidebarSelectedId}
													onClick={() => toggleTask(t)}
													onDelete={() => deleteTask(t)}
													onWait={() => toggleWaiting(t)}
												/>
											</motion.div>
										))
									)}
								</div>
							)}
						</div>

						{/* LOOPS accordion — the active repo's scheduled agent sessions.
						    Each loop owns one persistent task; clicking a row opens that
						    task's terminal (or the Loops tab before its first run). It
						    stacks right under Tasks like every other accordion, so a
						    collapsed Tasks brings it straight up. */}
						<div className="side-section">
							<div className="section-head tasks-head">
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
									onClick={() => setLoopDialog({ editId: null })}
									disabled={!activeProjectId}
								/>
							</div>
							{!loopsCollapsed && (
								<div className="side-list">
									{sortedLoops.length === 0 ? (
										<div className="tree-empty">No loops</div>
									) : (
										sortedLoops.map((l) => {
											const task = l.taskId
												? (activeTasks.find((t) => t.id === l.taskId) ?? null)
												: null;
											return (
												<LoopRow
													key={l.id}
													loop={l}
													task={task}
													selected={task != null && task.id === sidebarSelectedId}
													onClick={() => (task ? toggleTask(task) : goToView("loops"))}
												/>
											);
										})
									)}
								</div>
							)}
						</div>
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
						{/* The tab stays lit while a task is focused over it: the focused
						    task belongs to a view, and the lit tab is where closing it
						    lands you. */}
						<div
							className={`tab ${view === "board" ? "active" : ""}`}
							onClick={() => goToView("board")}
						>
							Board
						</div>
						<div
							className={`tab ${view === "loops" ? "active" : ""}`}
							onClick={() => goToView("loops")}
						>
							Loops
						</div>
						<div
							className={`tab ${view === "lead" ? "active" : ""}`}
							onClick={() => goToView("lead")}
						>
							Lead
						</div>
					</div>
					{/* Centered task search: the topbar is a 1fr | search | 1fr grid, so
					    the tabs on the left and action buttons on the right don't shift
					    it while both fit, and it shrinks rather than covering them when
					    they don't. */}
					<TaskSearch
						query={taskQuery}
						onQuery={setTaskQuery}
						projectIds={searchProjectIds}
						tasks={activeTasks}
						describeTask={(t) => {
							const age = relativeAge(t.lastEventAt, Date.now());
							const box = originOf(t.projectId);
							return [
								COLUMNS.find((c) => c.key === t.column)?.label,
								age && (age === "just now" ? age : `${age} ago`),
								box && aliasLabel(box),
							]
								.filter(Boolean)
								.join(" · ");
						}}
						onOpenTask={openTask}
						onOpenSession={openSessionHit}
					/>
					<div className="topbar-right">
						{/* Mission Control's other option, only while its grid is up: what
						    the tiles show. */}
						{mcGridShown && (
							<div className="mclayout mcmodes" role="group" aria-label="Show">
								{(
									[
										["tasks", "Tasks"],
										["loops", "Loops"],
									] as const
								).map(([mode, label]) => (
									<button
										key={mode}
										type="button"
										className={`navbtn mcmode ${mcMode === mode ? "active" : ""}`}
										aria-pressed={mcMode === mode}
										onClick={() => setMcMode(mode)}
									>
										{label}
									</button>
								))}
							</div>
						)}
						{/* Always shown, and the way into Mission Control (it has no tab):
						    picking a layout opens the grid in it. Lit like a tab: only on
						    Mission Control (a task focused over it included), so from the
						    Board none of them reads as current. Under Auto only Auto is
						    lit; its tooltip names the layout it fitted. */}
						<div className="mclayout" role="group" aria-label="Mission Control layout">
							<button
								type="button"
								className={`navbtn icon ${view === "mission" && mcChoice === "auto" ? "active" : ""} ${
									mcRefitDue ? "refit" : ""
								}`}
								title={
									mcRefit && mcRefitDue
										? `Mission Control: Auto layout. ${mcTileCount} live now: click to fit them in ${mcLayoutLabel(mcRefit)}`
										: view !== "mission" || mcChoice !== "auto"
											? "Mission Control: Auto layout (fits the live terminals each time it opens)"
											: mcFitPending
												? "Mission Control: Auto layout (fits the terminals once one is live)"
												: `Mission Control: Auto layout (${mcLayoutLabel(mcLayout)} for the live terminals; click to fit again)`
								}
								aria-label="Mission Control: Auto layout"
								aria-pressed={view === "mission" && mcChoice === "auto"}
								onClick={chooseAutoLayout}
							>
								<LayoutDashboard size={14} strokeWidth={1.75} />
							</button>
							{MC_LAYOUTS.map(([mode, Icon, label]) => (
								<button
									key={mode}
									type="button"
									className={`navbtn icon ${view === "mission" && mcChoice === mode ? "active" : ""}`}
									title={`Mission Control: ${label} layout`}
									aria-label={`Mission Control: ${label} layout`}
									aria-pressed={view === "mission" && mcChoice === mode}
									onClick={() => {
										setMcLayout(mode);
										goToView("mission");
									}}
								>
									<Icon size={14} strokeWidth={1.75} />
								</button>
							))}
							<button
								type="button"
								className="navbtn icon"
								title="Sync with sidebar: put the tiles in the sidebar's current order (they never reorder on their own)"
								aria-label="Sync Mission Control order with sidebar"
								disabled={!activeProjectId}
								onClick={syncMission}
							>
								<RefreshCw size={14} strokeWidth={1.75} />
							</button>
						</div>
						<button
							type="button"
							className="navbtn"
							onClick={cleanup}
							disabled={!activeProjectId || cleanupBlockedBy !== null}
							title={
								cleanupBlockedBy !== null
									? `This project lives on a box running an older Ateam (protocol v${cleanupBlockedBy}). Cleanup needs v${FEATURE_MIN_VERSION.cleanup} or newer: update the box to use it here.`
									: undefined
							}
						>
							<Brush size={14} strokeWidth={1.75} />
							Clean up
							{archivedCount > 0 && <span className="muted">{archivedCount} archived</span>}
						</button>
						<button type="button" className="navbtn" onClick={newTask} disabled={!activeProjectId}>
							<Plus size={14} strokeWidth={1.75} />
							New task
						</button>
						{/* Opens the Lead as a sidebar on the right. Once open, the sidebar's
						    own strip holds the hide toggle in this same spot. From the Lead
						    tab, the chat moves beside the board. */}
						{!leadShown && (
							<button
								type="button"
								className="navbtn icon"
								title="Show Lead sidebar"
								aria-label="Show Lead sidebar"
								onClick={() => {
									setLeadSide(true);
									if (view === "lead") goToView("board");
								}}
							>
								<PanelRight size={14} strokeWidth={1.75} />
							</button>
						)}
					</div>
				</div>

				<div className="content">
					{/* Focus: a task open full-width covers whichever view it was opened
					    from, rather than being a fourth view of its own. The view keeps
					    its tab lit, and collapsing or closing lands back on it — so
					    there is one panel here, not one per view. */}
					{selectedTask && panelMode === "full" && selectedOffline ? (
						<OfflineTaskPanel
							task={selectedTask}
							label={aliasLabel(selectedOffline)}
							asleep={connections.some((c) => c.alias === selectedOffline && c.asleep)}
							waking={wakingAlias === selectedOffline}
							steps={connectSteps[selectedOffline]}
							mode={panelMode}
							onWake={() => void wakeBox(selectedOffline)}
							onClose={() => setSelectedTaskId(null)}
						/>
					) : selectedTask && panelMode === "full" ? (
						<TaskPanel
							task={selectedTask}
							agents={agents}
							envAgents={envAgents}
							alias={originOf(selectedTask.projectId)}
							onInstallAgent={installAgentOn}
							mode={panelMode}
							onSetMode={(m) => (m === "side" ? collapseFocus() : setPanelMode(m))}
							collapseLabel={FOCUS_COLLAPSE_LABEL[view]}
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
					) : view === "board" ? (
						<>
							<Board
								tasks={filteredBoardTasks}
								issues={backlogIssues.filter(
									(issue) =>
										!query ||
										`${issue.title} #${issue.number} ${issue.labels.map((label) => `#${label}`).join(" ")}`
											.toLowerCase()
											.includes(query),
								)}
								issueActions={
									issueRepository && (
										<span className="issue-actions">
											<button
												type="button"
												className="iconbtn"
												aria-label="Refresh GitHub issues"
												title="Refresh GitHub issues"
												onClick={(event) => {
													event.stopPropagation();
													void issueSync.refresh(true);
												}}
											>
												<RotateCw size={12} className={issueSync.loading ? "spin" : undefined} />
											</button>
											<button
												type="button"
												className="iconbtn"
												aria-label="New GitHub issue"
												title="New GitHub issue"
												onClick={(event) => {
													event.stopPropagation();
													setNewIssueOpen(true);
												}}
											>
												<Plus size={13} />
											</button>
										</span>
									)
								}
								issueStatus={
									issueRepository && issueSync.error ? (
										<div className="issue-sync">
											<output>
												{issueSync.error}
												{issueSync.syncedAt ? " Showing last sync." : ""}
											</output>
										</div>
									) : null
								}
								selectedIssueNumber={visibleIssue?.number ?? null}
								onSelectIssue={(issue) => {
									setSelectedTaskId(null);
									setSelectedIssue(issue);
								}}
								selectedId={selectedTaskId}
								onSelect={(id) => {
									setSelectedIssue(null);
									selectFromBoard(id);
								}}
								onDeselect={() => {
									setSelectedTaskId(null);
									setSelectedIssue(null);
								}}
								// Badge a card only when it runs on a box — Local is the default, so
								// tagging it would be noise. `null` = no badge.
								originLabel={(t) => {
									const a = originOf(t.projectId);
									if (!a) return null;
									if (!offlineAliasOf(t)) return aliasLabel(a);
									return `${aliasLabel(a)} · ${connections.find((c) => c.alias === a)?.asleep ? "asleep" : "offline"}`;
								}}
								isOffline={(t) => offlineAliasOf(t) !== null}
							/>
							{visibleIssue && (
								<GithubIssuePanel
									issue={visibleIssue}
									onClose={() => setSelectedIssue(null)}
									onStart={() => {
										setComposerIssue(visibleIssue);
										setComposerOpen(true);
									}}
								/>
							)}
							{selectedTask && selectedOffline ? (
								<OfflineTaskPanel
									task={selectedTask}
									label={aliasLabel(selectedOffline)}
									asleep={connections.some((c) => c.alias === selectedOffline && c.asleep)}
									waking={wakingAlias === selectedOffline}
									steps={connectSteps[selectedOffline]}
									mode={panelMode}
									onWake={() => void wakeBox(selectedOffline)}
									onClose={() => setSelectedTaskId(null)}
								/>
							) : selectedTask ? (
								<TaskPanel
									task={selectedTask}
									agents={agents}
									envAgents={envAgents}
									alias={originOf(selectedTask.projectId)}
									onInstallAgent={installAgentOn}
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
							) : null}
						</>
					) : view === "mission" ? (
						<MissionControl
							// One instance per project: tiles, page, pinned tabs and the
							// tile order all belong to the project, and the session
							// fetch runs on mount and on events only, so a project switch
							// that kept this instance showed the last project's tiles
							// until some agent happened to emit an event. Same for the
							// Tasks/Loops switch: a new mode is a new set of tiles.
							key={mcGridKey}
							mode={mcMode}
							tasks={missionTasks}
							agents={agents}
							order={missionOrderIds}
							layout={mcLayout}
							holdForFit={mcFitPending && mcChoice === "auto"}
							syncSeq={mcSyncSeq}
							onExpand={openFromMission}
							highlightId={mcHighlightId}
							onHighlight={setMcHighlightId}
							jump={mcJump}
							onJumpMissing={(id) => {
								const t = activeTasks.find((x) => x.id === id);
								if (t) openTask(t);
							}}
							onReorder={reorderMission}
							onNewTask={activeProjectId ? newTask : undefined}
						/>
					) : view === "settings" ? (
						<SettingsPanel agents={agents} />
					) : view === "lead" ? (
						<LeadChat tasks={allTasks} onOpenTask={openTask} />
					) : (
						<LoopsPanel
							loops={sortedLoops}
							members={activeMembers}
							envProtocol={envProtocol}
							onChanged={refreshLoops}
							onNew={() => setLoopDialog({ editId: null })}
							onEdit={(id) => setLoopDialog({ editId: id })}
						/>
					)}
				</div>
			</main>

			{leadShown && (
				<>
					{/* Its edge drags like the left sidebar's. */}
					<div
						className="lead-resizer"
						onMouseDown={startLeadResize}
						role="separator"
						aria-orientation="vertical"
						aria-label="Resize Lead sidebar"
					/>
					<aside className="lead-side" aria-label="Lead">
						<LeadChat tasks={allTasks} onOpenTask={openTask} onHide={() => setLeadSide(false)} />
					</aside>
				</>
			)}

			{cleanupOpen && activeProjectId && (
				<CleanupDialog
					projectId={activeProjectId}
					confirm={confirm}
					reload={() => activeProjectId && loadTasks(activeProjectId)}
					onClose={() => {
						setCleanupOpen(false);
						setArchivedTick((n) => n + 1);
					}}
				/>
			)}
			{newIssueOpen && issueRepository && (
				<NewIssueDialog
					repository={issueRepository}
					onClose={() => setNewIssueOpen(false)}
					onCreated={(issue) => {
						setNewIssueOpen(false);
						setSelectedTaskId(null);
						setSelectedIssue(issue);
						void issueSync.refresh();
					}}
				/>
			)}
			{composerOpen && activeCard && (
				<PromptComposer
					agents={agents}
					initialName={composerIssue?.title}
					initialPrompt={
						composerIssue
							? `${composerIssue.title}\n\n${composerIssue.url}\n\n${composerIssue.body}`
							: undefined
					}
					initialFiles={composerFiles}
					environments={composerEnvs}
					envAgents={envAgents}
					onAdd={addTailscaleBox}
					onInstall={installBox}
					onForget={forgetBox}
					onInstallAgent={installAgentOn}
					onClose={() => {
						setComposerOpen(false);
						setComposerIssue(null);
						setComposerFiles([]);
					}}
					onCreate={composeTask}
				/>
			)}
			{loopDialog && activeCard && (loopDialog.editId === null || editingLoop) && (
				<LoopForm
					key={loopDialog.editId ?? "new"}
					editing={editingLoop ?? undefined}
					members={activeMembers}
					agents={agents}
					envProtocol={envProtocol}
					onInstallAgent={installAgentOn}
					onCancel={() => setLoopDialog(null)}
					onSaved={() => {
						refreshLoops();
						// The sidebar's Loops section starts collapsed: open it so a new
						// loop lands somewhere visible, whichever view is behind the dialog.
						if (loopDialog.editId === null) setLoopsCollapsed(false);
						setLoopDialog(null);
					}}
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
					{/* Waking a box can take minutes: say which step it is on. */}
					{provisioning && connectSteps[provisioning]?.length ? (
						<ConnectSteps steps={connectSteps[provisioning]} />
					) : null}
				</div>
			)}
		</div>
	);
}

/**
 * What the row's trailing slot says once no agent is attached.
 *
 * With a live agent the slot belongs to `agentStatus` (blue working, amber
 * needs-you) — that is the most urgent thing a row can report. The rest of the
 * time the useful question is the state of the WORK, which is exactly what
 * `triage` answers, from the task row alone and with no git/gh calls. Before
 * this, every such task wore the same green "idle" dot, so a task merged last
 * week, one that never started, and one genuinely waiting on you were
 * indistinguishable.
 *
 * `active` and `not_started` fall through to null deliberately: "recently
 * touched" and "nothing here yet" are the row's resting state, and a glyph for
 * them would be noise on every row.
 */
function TriageGlyph({ triage }: { triage: TaskTriage }) {
	const props = { size: 12, strokeWidth: 2 } as const;
	const glyph = (() => {
		switch (triage.bucket) {
			case "merged_done":
				return { icon: <GitMerge {...props} />, tone: "done" };
			case "merged_unfinished":
				return { icon: <GitMerge {...props} />, tone: "attention" };
			case "open_pr":
				return { icon: <GitPullRequest {...props} />, tone: "open" };
			case "unmerged_no_pr":
				return { icon: <GitCommitVertical {...props} />, tone: "done" };
			case "uncommitted":
				return { icon: <GitCommitVertical {...props} />, tone: "attention" };
			case "orphan":
				return { icon: <CircleAlert {...props} />, tone: "alert" };
			default:
				return null;
		}
	})();
	if (!glyph) return null;
	return (
		<span className={`tstate ${glyph.tone}`} title={triage.reason}>
			{glyph.icon}
		</span>
	);
}

/**
 * The panel for a task whose box isn't held. Everything a TaskPanel shows lives
 * on the box (terminals, worktree, diff), so this stands in until the box answers:
 * waking it when the task was opened, or offering to when it wasn't (a selection
 * restored on launch must not wake a box by itself).
 */
function OfflineTaskPanel({
	task,
	label,
	asleep,
	waking,
	steps,
	mode,
	onWake,
	onClose,
}: {
	task: TaskDTO;
	label: string;
	asleep: boolean;
	waking: boolean;
	steps: ConnectStep[] | undefined;
	mode: "side" | "full";
	onWake: () => void;
	onClose: () => void;
}) {
	return (
		<section className={`panel ${mode === "full" ? "full" : ""}`}>
			<div className="head">
				<div style={{ display: "flex", justifyContent: "space-between" }}>
					<span className="title">{task.name}</span>
					<IconButton icon={X} label="Close" onClick={onClose} />
				</div>
				<BranchLine task={task} />
			</div>
			<div className="empty">
				{waking ? (
					<>
						Waking {label}…{steps?.length ? <ConnectSteps steps={steps} /> : null}
					</>
				) : (
					<>
						{label} is {asleep ? "asleep" : "out of reach"}, so this task is as it was last seen.
						<br />
						<button type="button" className="navbtn" onClick={onWake}>
							Wake {label}
						</button>
					</>
				)}
			</div>
		</section>
	);
}

function TaskRow({
	task: t,
	offline,
	selected,
	onClick,
	onDelete,
	onWait,
}: {
	task: TaskDTO;
	/** Its box isn't held: the row is its last-seen state, not a live one. */
	offline: boolean;
	selected: boolean;
	onClick: () => void;
	onDelete: () => void;
	onWait: () => void;
}) {
	const Icon = taskIcon(t.name);
	const tags = tagsFor(t);
	const glyphs = taskGlyphs(t);
	// Row and trailing slot are siblings so the trash click can't nest inside the
	// row button (same pattern as proj-row / proj-open above). The status dot and
	// delete button share the trailing slot and swap in place on hover.
	return (
		<div className="tasknode-row">
			<button
				type="button"
				className={`tasknode ${selected ? "selected" : ""} ${offline ? "offline" : ""}`}
				title={offline ? "Its box is asleep or out of reach. Open it to wake the box." : undefined}
				onClick={onClick}
			>
				{glyphs.length > 0 ? (
					<span className="ticon glyphs">
						<SessionGlyphs ids={glyphs} size={14} />
					</span>
				) : (
					<Icon className="ticon" size={14} strokeWidth={1.75} />
				)}
				<span className={`tname ${t.isUnread ? "unread-row" : ""}`}>{t.name}</span>
				{/* Hover-only, like the card's. The name already ellipsizes, so it
				    simply truncates further to make room and the row never changes
				    height. */}
				{tags.length > 0 && (
					<span className="row-tags">
						{tags.map((tag) => (
							<span className="tag" key={tag}>
								{tag}
							</span>
						))}
					</span>
				)}
			</button>
			<span className="task-trail">
				{/* A task is `preparing` before it has any agentStatus, so this is
				    the one dot it gets — otherwise the trail is empty for the whole
				    copy and the card looks idle while it is anything but. */}
				{t.preparing ? (
					<span className="tstatus preparing" title="Copying dependencies into the worktree…" />
				) : t.agentStatus === "running" || t.agentStatus === "awaiting_input" ? (
					// A live agent keeps this slot. `stalled` means it claims to be
					// running but stopped advancing, so it wears the card's hollow
					// treatment rather than the pulsing live one.
					<span
						className={`tstatus ${t.triage.bucket === "stalled" ? "stalled" : t.agentStatus}`}
						title={t.triage.reason}
					/>
				) : (
					<TriageGlyph triage={t.triage} />
				)}
				{/* Two hover actions share the dot's cell; on a parked task the
				    hourglass reads lit, so the hover also says "this one is waiting". */}
				<span className="trail-actions">
					<IconButton
						icon={Hourglass}
						label={t.waitingUntil != null ? "Stop waiting" : "Wait on someone…"}
						active={t.waitingUntil != null}
						size={14}
						onClick={onWait}
					/>
					<IconButton
						icon={Trash2}
						label="Delete task"
						variant="danger"
						size={14}
						onClick={onDelete}
					/>
				</span>
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
	issues,
	issueActions,
	issueStatus,
	selectedIssueNumber,
	onSelectIssue,
	selectedId,
	onSelect,
	onDeselect,
	originLabel,
	isOffline,
}: {
	tasks: TaskDTO[];
	issues: GithubIssueDTO[];
	issueActions: ReactNode;
	issueStatus: ReactNode;
	selectedIssueNumber: number | null;
	onSelectIssue: (issue: GithubIssueDTO) => void;
	selectedId: string | null;
	onSelect: (id: string) => void;
	onDeselect: () => void;
	/** Engine badge for a task (e.g. a box alias), or null to show none (Local). */
	originLabel: (t: TaskDTO) => string | null;
	/** Its box isn't held: the card is its last-seen state, not a live one. */
	isOffline: (t: TaskDTO) => boolean;
}) {
	// The side panel is sticky over the right edge of the board (the board keeps
	// its full width rather than reflowing), so a selected card in a right-hand
	// column sits underneath it. Scroll it clear: `.card.selected` reserves the
	// panel's width as scroll-margin-right, and "nearest" then no-ops whenever
	// the card is already in the clear, so we never yank a board the user placed.
	const selectedRef = useRef<HTMLDivElement | null>(null);
	const revealSelected = useCallback(() => {
		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		selectedRef.current?.scrollIntoView({
			behavior: reduced ? "auto" : "smooth",
			block: "nearest",
			inline: "nearest",
		});
	}, []);
	// Selecting doesn't move the card, so reveal it in the same commit that opens
	// the panel. A task that later changes status animates to its new column, and
	// mid-flight the card's box is a transform of the old spot — scrolling then
	// would chase a moving target, so that case waits for the layout animation
	// to land (below) instead of keying this effect on the column.
	useEffect(() => {
		if (selectedId) revealSelected();
	}, [selectedId, revealSelected]);

	return (
		// Clicking empty board space deselects; card clicks stopPropagation.
		<div className="board" onClick={onDeselect}>
			{COLUMNS.map((col) => {
				// Latest activity on top, the sidebar's "Recently updated" order: a
				// task that just finished a turn is the first card in its column, not
				// wherever its creation date (or its machine) put it.
				const items = tasks.filter((t) => t.column === col.key).sort(byLatestActivity);
				return (
					<div className="col" key={col.key}>
						<h3>
							{col.label}{" "}
							<span className="count">
								{items.length + (col.key === "todo" ? issues.length : 0)}
							</span>
							{col.key === "todo" && issueActions}
						</h3>
						{col.key === "todo" && issueStatus}
						{col.key === "todo" && issues.length > 0 && (
							<>
								{issues.map((issue) => (
									<GithubIssueCard
										key={issue.number}
										issue={issue}
										selected={issue.number === selectedIssueNumber}
										onSelect={() => onSelectIssue(issue)}
									/>
								))}
							</>
						)}
						{items.map((t) => {
							const tags = tagsFor(t);
							const glyphs = taskGlyphs(t);
							const isSelected = t.id === selectedId;
							return (
								<motion.div
									key={t.id}
									layout
									transition={springy}
									ref={isSelected ? selectedRef : undefined}
									// Fires after any layout animation settles — a status change
									// carrying the card to another column, or cards above it coming
									// and going. Re-check from the card's final resting box.
									onLayoutAnimationComplete={isSelected ? revealSelected : undefined}
									className={`card ${isSelected ? "selected" : ""} ${isOffline(t) ? "offline" : ""}`}
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
									{/* No branch line: the branch is the name as a slug, so the card
								    carries state instead and the branch lives in the open task.
								    Tags show on hover inside the name's line, the sidebar row's
								    treatment, so hovering never reflows the board. */}
									<div className="name">
										<span className="name-text">
											{t.isUnread && <span className="unread" title="New since you last looked" />}
											{t.name}
										</span>
										{tags.length > 0 && (
											<span className="card-tags">
												{tags.map((tag) => (
													<span className="tag" key={tag}>
														{tag}
													</span>
												))}
											</span>
										)}
									</div>
									{originLabel(t) && (
										<span className="card-env muted" style={{ fontSize: 10 }}>
											{originLabel(t)}
										</span>
									)}
									{/* Why this card is where it is — the triage verdict that until now
								    was computed on every refresh and shown only to the MCP tool. */}
									{/* Parked on an outside party: the wait IS why the card is where it
								    is, so it takes the triage line over until it ends. */}
									<div
										className={`triage wait-${waitState(t, Date.now())}`}
										title={waitingLabel(t, Date.now()) ?? t.triage.reason}
									>
										{waitingLabel(t, Date.now()) ?? t.triage.reason}
									</div>
									<div className="meta">
										<WorkSize task={t} files />
										{t.issueUrl && (
											<a
												className="issue-link"
												href={t.issueUrl}
												target="_blank"
												rel="noreferrer"
												onClick={(event) => event.stopPropagation()}
											>
												Issue #{t.issueUrl.split("/").pop()}
											</a>
										)}
										{t.prNumber && <span>PR #{t.prNumber}</span>}
										{t.mergeStatus && (
											<span className={`merge-status ${t.mergeStatus}`}>
												{t.mergeStatus === "conflict" ? "merge conflict" : t.mergeStatus}
											</span>
										)}
										{/* Age and agent icon share one right-aligned group: the icon used to
									    be absolutely positioned and sat on top of the age label. */}
										<span className="meta-end">
											{relativeAge(t.lastEventAt, Date.now()) && (
												<span className="age">{relativeAge(t.lastEventAt, Date.now())}</span>
											)}
											{glyphs.length > 0 && (
												<span className="glyphs">
													<SessionGlyphs ids={glyphs} size={15} />
												</span>
											)}
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

/**
 * How big a task's work is: `+N -M` lines, as the task panel's button counts
 * them (the same diff, read from the git sweep's snapshot). `files` adds the
 * file count, for the card. Nothing until the sweep has measured the lines,
 * which an older engine never does.
 */
function WorkSize({ task, files = false }: { task: TaskDTO; files?: boolean }) {
	const g = task.gitStatus;
	if (!g) return null;
	const lines = g.additions != null && g.deletions != null && g.additions + g.deletions > 0;
	const showFiles = files && g.dirty > 0;
	if (!lines && !showFiles) return null;
	return (
		<span className="work-size">
			{lines && (
				<>
					<span className="add">+{g.additions}</span> <span className="del">-{g.deletions}</span>
				</>
			)}
			{lines && showFiles && " · "}
			{showFiles && `${g.dirty} ${g.dirty === 1 ? "file" : "files"}`}
		</span>
	);
}

/**
 * The open task's branch, the one place it shows: here is where you act on
 * git, so a click copies it. Commits ahead of / behind the pushed branch ride
 * along when there are any.
 */
function BranchLine({ task }: { task: TaskDTO }) {
	const [copied, setCopied] = useState(false);
	const ahead = task.gitStatus?.ahead ?? 0;
	const behind = task.gitStatus?.behind ?? 0;
	const copy = () => {
		void navigator.clipboard.writeText(task.branch).then(
			() => {
				setCopied(true);
				window.setTimeout(() => setCopied(false), 1200);
			},
			() => {},
		);
	};
	return (
		<div className="branch-line muted">
			<button
				type="button"
				className="branch-copy"
				title={copied ? "Copied" : "Copy branch name"}
				aria-label={`Copy branch name ${task.branch}`}
				onClick={copy}
			>
				<GitBranch size={12} strokeWidth={1.75} />
				<span className="branch-name">{task.branch}</span>
				{copied ? <Check size={11} /> : <Copy size={11} className="copy-icon" />}
			</button>
			<span className="branch-base">← {task.baseBranch}</span>
			{(ahead > 0 || behind > 0) && (
				<span title="Commits not yet pushed / commits on the pushed branch you don't have">
					↑{ahead} ↓{behind}
				</span>
			)}
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
	/** Install a coding agent's CLI on this task's environment (the picker's flow). */
	onInstallAgent: (alias: Alias, agentId: string) => Promise<{ loginCommand?: string }>;
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
	// The browser on the task's box (its Chrome in noVNC). Kept mounted once
	// loaded, like the editor, so hiding it doesn't drop the VNC session.
	const [browserSrc, setBrowserSrc] = useState<string | null>(null);
	const [browserOpen, setBrowserOpen] = useState(false);
	const [browserBusy, setBrowserBusy] = useState<string | null>(null);
	// Dock the agent terminal as a right sidebar while the editor or the changes
	// view owns the main area — the agent keeps working in view instead of
	// vanishing behind it. Default on; the left-sidebar variant was left out.
	const [termSide, setTermSide] = useState(() => localStorage.getItem("ateam.termSide") !== "0");
	const toggleTermSide = () =>
		setTermSide((s) => {
			localStorage.setItem("ateam.termSide", s ? "0" : "1");
			return !s;
		});
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
	// Tabs that were open when the app last went down. Same tagging rule as
	// `loaded`: the render right after a task switch still holds the previous
	// task's list. An empty array is the honest default here — unlike `sessions`,
	// nothing decides anything from "this task has none".
	const [dead, setDead] = useState<{ taskId: string; sessions: SessionDTO[] } | null>(null);
	const restorable = dead?.taskId === task.id ? dead.sessions : [];

	// Selecting another task closes the changes view — and leaves the previous
	// task's editor behind: the panel isn't remounted per task, so the iframe
	// would keep showing the old worktree (worst after a rename, where that
	// folder no longer exists). Close both; the next open resolves the new
	// task's own URL.
	// biome-ignore lint/correctness/useExhaustiveDependencies: task.id is the trigger, not a value the body reads — the resets must run on every task switch.
	useEffect(() => {
		setChangesOpen(false);
		setViewFile(null);
		setEditorOpen(false);
		setEditorSrc(null);
		setEditorBusy(null);
		setBrowserOpen(false);
		setBrowserSrc(null);
		setBrowserBusy(null);
	}, [task.id]);

	const refreshSessions = useCallback(async () => {
		const taskId = task.id;
		const [live, stranded] = await Promise.all([
			window.ateam.pty.listForTask(taskId),
			window.ateam.pty.listRestorable(taskId),
		]);
		// The engine hands these back latest-first; reverse so the strip reads
		// oldest → newest — a new session then appends on the right instead of
		// shuffling the tabs already open.
		const ordered = live.reverse();
		const orderedDead = stranded.reverse();
		setLoaded({ taskId, sessions: ordered });
		setDead({ taskId, sessions: orderedDead });
		return { live: ordered, restorable: orderedDead };
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

	/**
	 * Bring a stranded tab back: a new terminal running the SAME conversation.
	 * Mirrors `launch` in using `setTerminal` rather than `showTerminal` — this
	 * also runs from the fallback effect below, which must not yank you out of
	 * the editor.
	 */
	const restoreTab = useCallback(
		(session: SessionDTO) =>
			run(async () => {
				const { terminalId: tid } = await window.ateam.pty.restoreSession({
					taskId: task.id,
					terminalId: session.terminalId,
				});
				await refreshSessions();
				setTerminal(tid);
			}),
		[task.id, run, setTerminal, refreshSessions],
	);

	/**
	 * "Resume last conversation": the newest tab a restart stranded, brought back
	 * by id, and failing that the newest conversation in the worktree. Same choice
	 * the tab-fallback effect makes below — this is the button for when that
	 * effect has already had its one go, or the task's column rules it out.
	 * Leaves the editor, like every other user gesture that shows a terminal.
	 */
	const resumeLast = useCallback(() => {
		setEditorOpen(false);
		setBrowserOpen(false);
		const newest = [...restorable].reverse().find((s) => s.agentId !== "shell");
		if (newest) void restoreTab(newest);
		else void launch(false, true);
	}, [restorable, restoreTab, launch]);

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
		void refreshSessions().then(({ live, restorable: stranded }) => {
			if (cancelled || live.length) return; // it wasn't empty after all
			if (terminalId !== null) setTerminal(null);
			if (!resumable) return;
			autoResumedRef.current = task.id;
			// Prefer the newest tab that was actually open when we went down: it
			// resumes THAT conversation by id. `launch(resume)` is the fallback for
			// a task with nothing stranded (or nothing but shells) — it can only
			// reach the newest conversation in the worktree, whichever tab that was.
			const newest = [...stranded].reverse().find((s) => s.agentId !== "shell");
			if (newest) void restoreTab(newest);
			else void launch(false, true);
		});
		return () => {
			cancelled = true;
		};
	}, [
		task.id,
		task.column,
		sessions,
		terminalId,
		setTerminal,
		launch,
		restoreTab,
		refreshSessions,
	]);

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

	/**
	 * Selecting a tab means "show me that terminal" — so it leaves whatever view
	 * is covering the terminal. Clicking a tab and seeing nothing change (because
	 * the editor still covered it) left no obvious way back out.
	 */
	const showTerminal = (tid: string | null) => {
		setTerminal(tid);
		setEditorOpen(false);
		setBrowserOpen(false);
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
		setBrowserOpen(false);
		if (!viewFile && diff?.files[0]) setViewFile(diff.files[0].path);
	};

	const tabs = sessionTabs(sessions ?? [], agents, restorable);

	// Whether a view covers the terminal, and whether the terminal instead docks
	// beside it (both open at once). Only when the toggle wants it.
	const mainViewOpen = editorOpen || browserOpen || changesOpen;
	const termDocked = termSide && mainViewOpen;

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
				<BranchLine task={task} />
			</div>

			<div className="actions">
				{/* Left: this task's terminals, and the `+` that opens another. What kind
				    of agent session you get is the composer's question, not a row of
				    buttons — so the row stays legible however many tabs are open. */}
				<div className="sess-tabs" role="tablist" aria-label="Sessions">
					{tabs.map(({ session, label, live }) => (
						<div
							key={session.terminalId}
							className={`sess-tab ${session.terminalId === terminalId ? "active" : ""} ${
								live ? "" : "restorable"
							}`}
						>
							<button
								type="button"
								role="tab"
								aria-selected={live && session.terminalId === terminalId}
								className="sess-tab-name"
								title={live ? label : `${label} — closed by a restart. Click to resume it.`}
								onClick={() => {
									if (live) {
										showTerminal(session.terminalId);
										return;
									}
									setEditorOpen(false);
									setBrowserOpen(false);
									setChangesOpen(false);
									void restoreTab(session);
								}}
							>
								<span className="sess-tab-icon">
									<SessionIcon agentId={session.agentId} size={14} />
								</span>
								<span>{label}</span>
							</button>
							{/* A stranded tab has no process to kill, and it retires itself
							    after one run of the app — so it carries no close button. */}
							{live && (
								<button
									type="button"
									className="sess-tab-close"
									aria-label={`Close ${label}`}
									title={`Close ${label}`}
									onClick={() => closeSession(session, label)}
								>
									<X size={14} />
								</button>
							)}
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
							{ label: "Resume last conversation", icon: History, onClick: resumeLast },
						]}
					/>
				</div>

				<span className="spacer" />

				<IconButton
					icon={VscodeLogo}
					active={editorOpen}
					label={editorOpen ? "Back to terminal" : "Edit files (VS Code on the task's machine)"}
					onClick={() => {
						if (editorOpen) {
							setEditorOpen(false);
							return;
						}
						void run(async () => {
							// Resolve on every open — never trust the cached src. The
							// worktree can move (a rename leaves the old ?folder= pointing
							// nowhere, and a stale cache would reopen that missing folder
							// for every task after it). Setting an identical src is a
							// React no-op, so a plain re-open doesn't reload the iframe.
							setEditorOpen(true);
							setBrowserOpen(false);
							setChangesOpen(false);
							setEditorBusy("Opening the editor…");
							try {
								let res = await window.ateam.editor.open(task.id);
								if ("needsInstall" in res) {
									// Inline coding is optional — nothing is installed without a yes.
									const where = alias === null ? "this Mac" : `"${alias}"`;
									const ok = await confirm(
										"Install the inline editor?",
										`Inline coding runs VS Code (code-server) on ${where} — a one-time, user-space install (~200 MB, no root). Install it now? It takes about a minute.`,
									);
									if (!ok) {
										setEditorOpen(false);
										return;
									}
									setEditorBusy(`Installing the inline editor on ${where}…`);
									await window.ateam.editor.install(task.id);
									res = await window.ateam.editor.open(task.id);
									if ("needsInstall" in res)
										throw new Error("Install finished but the editor is still missing.");
								}
								setEditorSrc(`${res.url}/?folder=${encodeURIComponent(task.worktreePath)}`);
							} catch (e) {
								// Back to the terminal — a blank editor pane would hide it.
								setEditorOpen(false);
								throw e;
							} finally {
								setEditorBusy(null);
							}
						});
					}}
				/>
				{/* The terminal only docks BESIDE something. With no view over it, it is
				    already full width (`termDocked || !mainViewOpen` below), so the
				    toggle changes nothing and offering it says otherwise. */}
				{mainViewOpen && (
					<IconButton
						icon={termSide ? PanelRightFilled : PanelRight}
						active={termSide}
						label={termSide ? "Hide terminal sidebar" : "Show terminal sidebar"}
						onClick={toggleTermSide}
					/>
				)}
				{/* Handing the worktree to the real VS Code belongs to the editor, so it
				    appears with it rather than sitting in the toolbar of a task nobody
				    is editing. */}
				{editorOpen && (
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
				)}
				{/* After the editor and its controls, not between them: each app keeps its
				    own controls beside it. This is the browser half of "hand this task to
				    a real app" — your own Chrome, so every session it holds is already
				    signed in and an agent never meets a login wall on its first useful
				    step. Its own controls will land to the right of it in turn. */}
				{/* Offered only where it can work, which is what the optional binding
				    means (see the protocol's note on `openBrowser`). Without this the
				    `?.` call swallows a missing binding and the button just does
				    nothing when clicked — which is exactly how it looks when a dev
				    session hot-reloads this file while the preload stays behind. */}
				{/* A task on a box drives the box's own Chrome, so there the button
				    opens that browser in a panel instead of raising this Mac's. */}
				{alias !== null ? (
					<IconButton
						icon={Globe}
						active={browserOpen}
						label={browserOpen ? "Back to terminal" : `Open the browser on "${alias}"`}
						onClick={() => {
							if (browserOpen) {
								setBrowserOpen(false);
								return;
							}
							void run(async () => {
								setBrowserOpen(true);
								setEditorOpen(false);
								setChangesOpen(false);
								// A loaded view stays connected (noVNC reconnects on its own),
								// so only the first open asks the box.
								if (browserSrc) return;
								setBrowserBusy("Opening the browser…");
								try {
									setBrowserSrc((await window.ateam.browser.view(task.id)).url);
								} catch (e) {
									setBrowserOpen(false);
									if (/Unknown method/.test(String(e)))
										throw new Error(`Update Ateam on "${alias}" to open its browser here.`);
									throw e;
								} finally {
									setBrowserBusy(null);
								}
							});
						}}
					/>
				) : (
					window.ateam.utils.openBrowser && (
						<IconButton
							icon={Globe}
							label="Open Chrome (the browser your agents drive)"
							onClick={() =>
								run(async () => {
									const res = await window.ateam.utils.openBrowser?.(alias);
									if (res && !res.ok) throw new Error(res.reason);
								})
							}
						/>
					)
				)}
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
							const r = await window.ateam.git.update(task.id);
							refreshDiff();
							if (r.status === "conflicts") {
								throw new Error(
									`Update hit conflicts in ${r.conflicts.join(", ")}. Resolve them in the worktree.`,
								);
							}
						})
					}
				/>
				<IconButton
					icon={GitMerge}
					label="Merge via PR (squash) + update local main"
					onClick={() =>
						run(async () => {
							const r = await window.ateam.git.merge(task.id, "squash");
							refreshDiff();
							// \`run\` shows a thrown error as the toast; a merge that did not
							// happen used to come back as a value and vanish.
							if (!r.ok) throw new Error(describeMergeResult(r).replace(/^Ateam: /, ""));
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

				<DiffStat diff={diff} open={changesOpen} onToggle={toggleChanges} />
			</div>

			{task.question && (
				<div className="panel-question">
					<QuestionCard task={task} />
				</div>
			)}
			<div className={`panel-body${termDocked ? " docked-term" : ""}`}>
				{/* Keep the terminal mounted (xterm state survives) while the
				    changes view is open — just hide it, or dock it beside the
				    view when the sidebar toggle is on. */}
				<div
					className="term-wrap"
					style={{ display: termDocked || !mainViewOpen ? "flex" : "none" }}
				>
					{terminalId ? (
						<TerminalView
							terminalId={terminalId}
							grammar={tabs.some(
								({ session }) => session.terminalId === terminalId && session.agentId !== "shell",
							)}
							showDone={task.column === "review"}
							onDone={() =>
								run(async () => {
									await window.ateam.tasks.setColumn(task.id, "merged");
								})
							}
						/>
					) : (
						<div className="term term-empty">
							<button type="button" onClick={resumeLast}>
								<History size={13} />
								Resume last conversation
							</button>
							<span className="muted">or open a tab with + to start a terminal</span>
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

				{(browserSrc || browserBusy) && (
					<div className="editor-wrap" style={{ display: browserOpen ? "flex" : "none" }}>
						{/* The box's Chrome, on its virtual desktop, in noVNC. */}
						{browserSrc ? (
							<iframe className="editor-frame" src={browserSrc} title="Browser" />
						) : (
							<div className="muted" style={{ display: "grid", placeItems: "center", flex: 1 }}>
								{browserBusy}
							</div>
						)}
					</div>
				)}

				{changesOpen && (
					<div className="changes-view">
						<ChangesList
							diff={diff}
							selected={viewFile}
							onSelect={setViewFile}
							onRefresh={refreshDiff}
						/>
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

			{task.page && task.question?.pageId !== task.page.id && (
				<div className="panel-page">
					<PageFrame taskId={task.id} pageId={task.page.id} title={task.page.title} collapsed />
				</div>
			)}
		</section>
	);
}

function MissionControl({
	mode,
	tasks,
	agents,
	order,
	layout,
	holdForFit,
	syncSeq,
	onExpand,
	highlightId,
	onHighlight,
	jump,
	onJumpMissing,
	onReorder,
	onNewTask,
}: {
	/** Which list `tasks` was drawn from; only the empty state and the New
	 *  task slot differ. */
	mode: "tasks" | "loops";
	tasks: TaskDTO[];
	/** Agent catalog, for naming a session's tab the way the task panel does. */
	agents: AgentDTO[];
	/** The rank tiles take on mount and on Sync; read at no other time. */
	order: string[];
	layout: McLayout;
	/** Auto is about to fit `layout` to the tile count this grid reports, so no
	 *  terminal should mount at a size it is about to leave. */
	holdForFit: boolean;
	/** Bumped by the Sync button: re-sort the tiles to `order` once. */
	syncSeq: number;
	onExpand: (task: TaskDTO, terminalId: string) => void;
	/** The tile drawn with the white edge. */
	highlightId: string | null;
	onHighlight: (taskId: string) => void;
	/** A sidebar click: page to this task's tile and focus its terminal. */
	jump: { id: string; seq: number } | null;
	/** The jumped-to task has no tile (no live session). */
	onJumpMissing: (taskId: string) => void;
	/** The tiles' order changed (a tile arrived, died, or was dragged). */
	onReorder: (tileIds: string[]) => void;
	/** Opens the task composer. Absent when there is no project to create in. */
	onNewTask?: () => void;
}) {
	// One tile per TASK, not per session: a task with an agent and two shells is
	// one piece of work, and splaying it across three identically-titled tiles
	// told you nothing. The tile shows one session at a time and its tabs switch
	// between them. Creating and closing sessions stays in the task panel, where
	// the + and the ✕ live; a tile is a viewport onto work that already exists.
	const [tiles, setTiles] = useState<{ task: TaskDTO; sessions: SessionDTO[] }[]>([]);
	// Which session each tile is showing. `pinned` marks a tab the viewer clicked,
	// which is then kept for as long as that session lives. An unpinned entry is
	// resolved the moment the tile arrives on the visible page (see below), and
	// absent — or pointing at a session that has since died — falls back to
	// activeTerminal.
	const [shownByTask, setShownByTask] = useState<
		Record<string, { terminalId: string; pinned: boolean }>
	>({});
	const tasksRef = useRef(tasks);
	tasksRef.current = tasks;
	const tilesRef = useRef(tiles);
	tilesRef.current = tiles;

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
	// Ctrl+Up/Down flips pages, and Cmd+Up/Down too: a PC keyboard's "ctrl" is
	// macOS Control, but people read it as Cmd, so either works. Capture phase
	// so it wins over the focused xterm textarea, which means a tile's shell
	// never sees these while Mission Control is open. macOS binds Ctrl+Up/Down
	// to Mission Control / App Exposé by default and swallows them before the
	// app; remapping those in System Settings frees them.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
			if (e.key === "ArrowDown") flip(1);
			else if (e.key === "ArrowUp") flip(-1);
			else return;
			e.preventDefault();
			e.stopPropagation();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [flip]);

	// Tiles never reorder on their own. `order` is read only when we land here
	// and when Sync is pressed; between those, tiles hold their slots however
	// the sidebar shuffles (agents finishing, statuses changing), so the tile
	// you are reaching for is the one you get. Tasks not in the rank sort last.
	const [rank, setRank] = useState(() => new Map(order.map((id, i) => [id, i])));
	// Snapshot during render, not in an effect, so the render that carries a
	// new syncSeq already carries the new rank and the forced re-sort uses it.
	const [syncSeen, setSyncSeen] = useState(syncSeq);
	if (syncSeen !== syncSeq) {
		setSyncSeen(syncSeq);
		setRank(new Map(order.map((id, i) => [id, i])));
	}

	// Latest unsorted tile list, kept so a re-sort (Sync) doesn't need a fresh
	// round of listForTask calls.
	const sessionsRef = useRef<{ task: TaskDTO; sessions: SessionDTO[] }[]>([]);
	// False until the first session fetch lands, so a fresh mount shows an empty
	// grid for that moment rather than flashing "No live agents yet".
	const [loaded, setLoaded] = useState(false);
	const rankRef = useRef(rank);

	// Lay the collected sessions out. `force` (mount, Sync) sorts every tile by
	// the rank. Otherwise tiles keep the slots they have: a tile whose session
	// died leaves, and a task that just got a live session joins at the end
	// (by rank among ones arriving together), so nothing already on screen
	// moves except to close a gap.
	const resort = useCallback((force = false) => {
		const r = rankRef.current;
		const byRank = (a: { task: TaskDTO }, b: { task: TaskDTO }): number =>
			(r.get(a.task.id) ?? Number.MAX_SAFE_INTEGER) - (r.get(b.task.id) ?? Number.MAX_SAFE_INTEGER);
		setTiles((prev) => {
			let next: { task: TaskDTO; sessions: SessionDTO[] }[];
			if (force) {
				// Stable sort; V8's stable sort keeps equal-rank ties in encounter order.
				next = [...sessionsRef.current].sort(byRank);
			} else {
				// Take the fresh tile objects, which carry the newly fetched task
				// DTOs and session lists, in the slots the old ones held.
				const fresh = new Map(sessionsRef.current.map((t) => [t.task.id, t]));
				const kept = prev.flatMap((t) => {
					const f = fresh.get(t.task.id);
					return f ? [f] : [];
				});
				const had = new Set(kept.map((t) => t.task.id));
				const arrived = sessionsRef.current.filter((t) => !had.has(t.task.id)).sort(byRank);
				next = [...kept, ...arrived];
			}
			// Keep the previous array when nothing moved so downstream renders
			// (and their terminals) see a stable identity.
			if (prev.length === next.length && prev.every((t, i) => t === next[i])) return prev;
			return next;
		});
	}, []);

	// A new rank (mount, Sync) is an explicit request for its order, so it
	// shows even when it only permutes the tiles already on screen. rankRef is
	// synced here (not at render time) so the effect legitimately depends on it.
	useEffect(() => {
		rankRef.current = rank;
		resort(true);
	}, [rank, resort]);

	// Report the tiles' order so it outlives this visit: the next visit (or a
	// project switch back) lays them out exactly as they were left.
	const onReorderRef = useRef(onReorder);
	onReorderRef.current = onReorder;
	useEffect(() => {
		if (loaded) onReorderRef.current(tiles.map((t) => t.task.id));
	}, [tiles, loaded]);

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
				// read oldest to newest, exactly as they do in the task panel. A
				// session whose agent quit (`stopped` while its PTY lives on as a
				// shell) is not an agent to watch, so it gets no tab here, and a task
				// left with none gets no tile. The task panel still has it.
				sessionsRef.current = perTask
					.map(({ task, sessions }) => ({
						task,
						sessions: sessions.filter((s) => s.status !== "stopped").reverse(),
					}))
					.filter(({ sessions }) => sessions.length > 0);
				resort();
				setLoaded(true);
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

	// The tiles this page actually shows. Computed before the empty-state return
	// so the arrival effect below runs on every render, as hooks must.
	const visible = tiles.slice(clampedPage * pageSize, clampedPage * pageSize + pageSize);
	const visibleRef = useRef(visible);
	visibleRef.current = visible;
	// Task ids on screen, in order: the effect's dependency, so it fires exactly
	// when the visible set changes and not on every session refresh.
	const onScreen = visible.map((t) => t.task.id).join(" ");
	const onScreenRef = useRef<Set<string>>(new Set());

	// A tile ARRIVING on the visible page — promoted by a reorder, or paged to —
	// lands on the session that most recently did something (activeTerminal with
	// no pick). That resolution is then held while the tile stays on screen: the
	// tab must not swap under someone reading it, or worse, mid-sentence into it,
	// because the task's other agent stirred. So this is deliberately not live:
	// it re-reads the room only at the moment the room changes.
	useEffect(() => {
		const ids = onScreen ? onScreen.split(" ") : [];
		const arriving = ids.filter((id) => !onScreenRef.current.has(id));
		onScreenRef.current = new Set(ids);
		if (arriving.length === 0) return;
		const sessionsById = new Map(visibleRef.current.map((t) => [t.task.id, t.sessions]));
		setShownByTask((m) => {
			let next = m;
			for (const id of arriving) {
				const sessions = sessionsById.get(id);
				if (!sessions) continue;
				const cur = m[id];
				// A tab the viewer chose outranks the news, until its session dies.
				if (cur?.pinned && sessions.some((s) => s.terminalId === cur.terminalId)) continue;
				const pick = activeTerminal(sessions, null);
				if (!pick || cur?.terminalId === pick) continue;
				if (next === m) next = { ...m };
				next[id] = { terminalId: pick, pinned: false };
			}
			return next;
		});
	}, [onScreen]);

	// Each tile's changes, for its +N -N and its changes view. Kept per task for
	// the grid's life, so flipping pages doesn't run git again for tiles already
	// counted.
	const [diffs, setDiffs] = useState<Record<string, DiffResultDTO>>({});
	// The tiles showing their changes instead of their terminal, each with the
	// file whose diff is open (null: the file list).
	const [changesOf, setChangesOf] = useState<Record<string, string | null>>({});
	const diffSeqRef = useRef(new Map<string, number>());
	const fetchDiff = useCallback((taskId: string) => {
		// Numbered, so an older answer landing after a newer one is dropped.
		const seq = (diffSeqRef.current.get(taskId) ?? 0) + 1;
		diffSeqRef.current.set(taskId, seq);
		window.ateam.git.diff(taskId).then(
			(d) => {
				if (diffSeqRef.current.get(taskId) === seq) setDiffs((m) => ({ ...m, [taskId]: d }));
			},
			// An unreachable box or an engine without git: the tile shows no stat.
			() => {},
		);
	}, []);
	// When to count a tile's changes: the first time it is on screen, and on
	// screen again once its agent finishes a turn (leaves "running"), which is
	// when that turn's edits are all in. Counting at a turn's start, or on every
	// event, would run git for nothing. Turns are read from `tasks`, the app's
	// live list; a tile's own copy is only as fresh as the last session fetch.
	const busyRef = useRef(new Map<string, boolean>());
	const countedRef = useRef(new Set<string>());
	useEffect(() => {
		for (const task of tasks) {
			const busy = task.agentStatus === "running";
			if (busyRef.current.get(task.id) && !busy) countedRef.current.delete(task.id);
			busyRef.current.set(task.id, busy);
		}
		for (const id of onScreen ? onScreen.split(" ") : []) {
			if (countedRef.current.has(id)) continue;
			countedRef.current.add(id);
			fetchDiff(id);
		}
	}, [tasks, onScreen, fetchDiff]);
	const toggleChanges = (taskId: string) => {
		if (taskId in changesOf) {
			setChangesOf((m) => Object.fromEntries(Object.entries(m).filter(([id]) => id !== taskId)));
			return;
		}
		fetchDiff(taskId); // opening is asking for the current state
		setChangesOf((m) => ({ ...m, [taskId]: null }));
	};

	// A sidebar click lands here: flip to the page holding that task's tile and
	// focus its terminal once the tile is on screen. Only jumps sent while
	// mounted count; the one left over from a previous visit is not a request.
	const handledJumpRef = useRef(jump?.seq ?? 0);
	const onJumpMissingRef = useRef(onJumpMissing);
	onJumpMissingRef.current = onJumpMissing;
	const pendingFocusRef = useRef<string | null>(null);
	const tileEls = useRef(new Map<string, HTMLDivElement>());
	useEffect(() => {
		if (!jump || jump.seq === handledJumpRef.current) return;
		handledJumpRef.current = jump.seq;
		const i = tilesRef.current.findIndex((t) => t.task.id === jump.id);
		if (i < 0) {
			onJumpMissingRef.current(jump.id);
			return;
		}
		const target = Math.floor(i / pageSizeRef.current);
		dirRef.current = Math.sign(target - pageRef.current);
		setPage(target);
		pendingFocusRef.current = jump.id;
	}, [jump]);
	// Every render, cheaply: runs after the flipped page's terminals mounted
	// (children's effects run first, and each focuses itself on mount), so this
	// focus is the one that sticks.
	useEffect(() => {
		const id = pendingFocusRef.current;
		const el = id ? tileEls.current.get(id) : undefined;
		if (!el) return;
		pendingFocusRef.current = null;
		el.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.focus();
	});

	// Drag a tile by its bar onto another tile and the two trade places;
	// nothing else moves, so the rest of the page stays where the eye left it.
	// The tiles' order is reported (and saved) like any other change.
	const dragIdRef = useRef<string | null>(null);
	const [dropTarget, setDropTarget] = useState<string | null>(null);
	const swapTiles = (a: string, b: string) => {
		const ta = tiles.find((t) => t.task.id === a);
		const tb = tiles.find((t) => t.task.id === b);
		if (!ta || !tb || ta === tb) return;
		setTiles(tiles.map((t) => (t === ta ? tb : t === tb ? ta : t)));
	};
	// Dragging across pages: while a tile is dragged, strips along the grid's
	// top and bottom edges flip the page when it is held over them (again every
	// FLIP_HOLD_MS while it stays), so it can be dropped onto a tile on another
	// page; the two still trade places. The
	// flip unmounts the dragged tile's page, so its own dragend may never
	// reach us: the drag is over at the first drop, dragend or mouse move
	// anywhere (no mouse events fire mid-drag).
	const [dragging, setDragging] = useState(false);
	const flipTimerRef = useRef<number | null>(null);
	const stopFlipTimer = useCallback(() => {
		if (flipTimerRef.current !== null) window.clearTimeout(flipTimerRef.current);
		flipTimerRef.current = null;
	}, []);
	useEffect(() => {
		if (!dragging) return;
		const end = () => {
			dragIdRef.current = null;
			stopFlipTimer();
			setDropTarget(null);
			setDragging(false);
		};
		window.addEventListener("drop", end, true);
		window.addEventListener("dragend", end, true);
		window.addEventListener("mousemove", end, true);
		return () => {
			window.removeEventListener("drop", end, true);
			window.removeEventListener("dragend", end, true);
			window.removeEventListener("mousemove", end, true);
			stopFlipTimer();
		};
	}, [dragging, stopFlipTimer]);
	const flipOnHold = (d: number) => ({
		onDragOver: () => {
			if (!dragging || flipTimerRef.current !== null) return;
			flipTimerRef.current = window.setTimeout(() => {
				flipTimerRef.current = null;
				flip(d);
			}, FLIP_HOLD_MS);
		},
		onDragLeave: stopFlipTimer,
	});

	// Tasks only: a loop's session is started by the loop, not from here.
	const newTaskButton =
		mode === "tasks" && onNewTask ? (
			<button type="button" className="navbtn" onClick={onNewTask}>
				<Plus size={14} strokeWidth={1.75} />
				New task
			</button>
		) : null;

	if (tiles.length === 0) {
		if (!loaded) return <div className="mc" data-layout={layout} />;
		// mc-none: centered in the whole area, not in the layout's first cell.
		return (
			<div className="mc mc-none" data-layout={layout}>
				{mode === "loops" ? (
					<div className="empty">
						No loop sessions running.
						<br />A loop shows up here while its session is live.
					</div>
				) : (
					<div className="empty">
						No live agents yet.
						<br />
						Start a task to watch its agent work here.
						{newTaskButton && (
							<>
								<br />
								{newTaskButton}
							</>
						)}
					</div>
				)}
			</div>
		);
	}
	// The tiles are counted; the layout to show them in lands next render.
	if (holdForFit) return <div className="mc" data-layout={layout} />;

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
					const shown = activeTerminal(sessions, shownByTask[task.id]?.terminalId ?? null);
					if (!shown) return null; // a task with no live session is not a tile
					const tabs = sessionTabs(sessions, agents);
					const diff = diffs[task.id];
					const changesOpen = task.id in changesOf;
					const openFile = changesOf[task.id] ?? null;
					return (
						<motion.div
							key={task.id}
							ref={(el: HTMLDivElement | null) => {
								if (el) tileEls.current.set(task.id, el);
								else tileEls.current.delete(task.id);
							}}
							className={`tile ${task.id === highlightId ? "highlighted" : ""} ${
								task.id === dropTarget ? "drop" : ""
							}`}
							// A reorder swaps terminals in and out of a page in silence — the
							// same four boxes, different work inside them — so the change had
							// to be announced. Tiles that keep their place glide to it (the
							// sidebar's treatment), and a tile arriving in a slot fades up
							// from nothing, which is the part you actually notice. Position
							// only: `layout` alone would scale a terminal mid-flight when the
							// page holds a different number of tiles than it did before.
							layout="position"
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							transition={{ layout: springy, opacity: { duration: 0.22 } }}
							// React's onFocus bubbles (focusin), so this fires when the
							// xterm textarea inside the tile gains focus.
							onFocus={() => onHighlight(task.id)}
							// The bar isn't focusable, so a click on it highlights here.
							onPointerDown={() => onHighlight(task.id)}
							onDragOver={(e) => {
								if (!e.dataTransfer.types.includes(MC_TILE_MIME)) return;
								e.preventDefault();
								e.dataTransfer.dropEffect = "move";
								const over = dragIdRef.current === task.id ? null : task.id;
								if (dropTarget !== over) setDropTarget(over);
							}}
							onDragLeave={(e) => {
								if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
								setDropTarget((d) => (d === task.id ? null : d));
							}}
							onDrop={(e) => {
								const from = e.dataTransfer.getData(MC_TILE_MIME);
								if (!from) return;
								e.preventDefault();
								setDropTarget(null);
								swapTiles(from, task.id);
							}}
						>
							{/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer drag handle; the sidebar's Custom order is the same ordering. */}
							<div
								className="bar movable"
								draggable
								title="Drag onto another tile to swap them"
								onDragStart={(e) => {
									dragIdRef.current = task.id;
									// Next tick: changing the DOM inside dragstart can make
									// Chromium cancel the drag it is starting.
									window.setTimeout(() => setDragging(true), 0);
									e.dataTransfer.setData(MC_TILE_MIME, task.id);
									e.dataTransfer.effectAllowed = "move";
								}}
								onDragEnd={() => {
									dragIdRef.current = null;
									setDropTarget(null);
								}}
							>
								<span className="bar-name">{task.name}</span>
								{/* What the terminal below can't show: whether it has a PR (its
								    size is the +N -M on the right). The branch used to sit here,
								    but it is the name again as a slug. */}
								{task.prNumber && <span className="bar-pr">PR #{task.prNumber}</span>}
								<span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
									{diff && (
										<DiffStat
											diff={diff}
											open={changesOpen}
											onToggle={() => toggleChanges(task.id)}
										/>
									)}
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
											onClick={() => {
												setShownByTask((m) => ({
													...m,
													[task.id]: { terminalId: session.terminalId, pinned: true },
												}));
												// A tab means "show me that terminal", as in the task panel.
												if (changesOpen) toggleChanges(task.id);
											}}
										>
											{label}
										</button>
									))}
								</div>
							)}
							{/* Hidden, not unmounted, under the changes view, so the xterm
							    survives (the task panel does the same). */}
							<div className="term-wrap" style={{ display: changesOpen ? "none" : "flex" }}>
								<TerminalView
									terminalId={shown}
									grammar={sessions.some((s) => s.terminalId === shown && s.agentId !== "shell")}
								/>
							</div>
							{/* A tile is too narrow for the panel's list-beside-diff, so the
							    list fills it and a file's diff opens in its place. */}
							{changesOpen && (
								<div className="mc-changes">
									{openFile ? (
										<FileDiffView
											taskId={task.id}
											file={openFile}
											split={false}
											closeLabel="Back to files"
											onClose={() => setChangesOf((m) => ({ ...m, [task.id]: null }))}
										/>
									) : (
										<ChangesList
											diff={diff ?? null}
											selected={null}
											onSelect={(path) => setChangesOf((m) => ({ ...m, [task.id]: path }))}
											onRefresh={() => fetchDiff(task.id)}
										/>
									)}
								</div>
							)}
						</motion.div>
					);
				})}
				{/* A page with room left (only ever the last one) offers a new task
				    in its first open slot; the tile that task grows takes the slot,
				    and the offer moves on to the next one, gliding like the tiles. */}
				{newTaskButton && visible.length < pageSize && (
					<motion.div
						key="mc-slot"
						className="mc-slot"
						layout="position"
						transition={{ layout: springy }}
					>
						{newTaskButton}
					</motion.div>
				)}
			</motion.div>
			{dragging && clampedPage > 0 && (
				<div className="mcflip top" {...flipOnHold(-1)}>
					<ChevronUp size={14} strokeWidth={1.75} /> Previous page
				</div>
			)}
			{dragging && clampedPage < pageCount - 1 && (
				<div className="mcflip bottom" {...flipOnHold(1)}>
					<ChevronDown size={14} strokeWidth={1.75} /> Next page
				</div>
			)}
			{pageCount > 1 && (
				<div className="mcpager">
					<IconButton
						icon={ChevronUp}
						label="Previous terminals"
						shortcut="⌃↑"
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
						shortcut="⌃↓"
						size={14}
						disabled={clampedPage === pageCount - 1}
						onClick={() => flip(1)}
					/>
					<span className="keys" aria-hidden="true">
						⌃↑↓
					</span>
				</div>
			)}
		</div>
	);
}
