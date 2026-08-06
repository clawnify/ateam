import type {
	AgentDTO,
	ConnectionDTO,
	DiffResultDTO,
	KanbanColumn,
	ProjectDTO,
	TaskDTO,
} from "@ateam/protocol";
import {
	ArrowDownToLine,
	ArrowUp,
	ArrowUpDown,
	BookOpen,
	Brush,
	Bug,
	Check,
	ChevronDown,
	ChevronRight,
	Columns2,
	Database,
	ExternalLink,
	FilePen,
	FlaskConical,
	FolderPlus,
	Gauge,
	GitBranch,
	GitCommitVertical,
	GitMerge,
	History,
	LayoutGrid,
	Lock,
	type LucideIcon,
	Maximize2,
	Minimize2,
	Palette,
	PanelLeft,
	Play,
	Plus,
	Rocket,
	RotateCw,
	Rows2,
	Search,
	Server,
	Sparkles,
	SquareTerminal,
	Trash2,
	Wrench,
	X,
	Zap,
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
import { NewTaskComposer } from "./components/NewTaskComposer";
import { TerminalView } from "./components/Terminal";
import { usePrompt } from "./components/usePrompt";
import { type Alias, aliasLabel, type UnifiedProject, unifyProjects } from "./unify";

const COLUMNS: { key: KanbanColumn; label: string }[] = [
	{ key: "todo", label: "Backlog" },
	{ key: "running", label: "In Progress" },
	{ key: "needs_attention", label: "Needs You" },
	{ key: "review", label: "Review" },
	{ key: "merged", label: "Done" },
];

// Pick an icon from what the task name suggests — like VSCode's file icons,
// but inferred from intent. First keyword match wins; GitBranch is the default.
const ICON_RULES: { icon: LucideIcon; re: RegExp }[] = [
	{ icon: Bug, re: /\b(bug|fix|hotfix|patch|broken|crash|error)\b/i },
	{ icon: BookOpen, re: /\b(readme|docs?|wiki|guide|changelog)\b/i },
	{ icon: Lock, re: /\b(auth|login|signin|security|permission|token|oauth)\b/i },
	{ icon: Palette, re: /\b(ui|ux|style|css|design|theme|button|layout|icon)\b/i },
	{ icon: FlaskConical, re: /\b(test|spec|e2e|coverage)\b/i },
	{ icon: Database, re: /\b(db|database|schema|migration|sql|drizzle|query)\b/i },
	{ icon: Server, re: /\b(api|endpoint|server|backend|route|webhook)\b/i },
	{ icon: Gauge, re: /\b(perf|performance|optimi|speed|cache|latency)\b/i },
	{ icon: Wrench, re: /\b(refactor|cleanup|chore|tidy|rename|config|setup)\b/i },
	{ icon: Rocket, re: /\b(release|deploy|launch|ship|publish)\b/i },
	{ icon: Sparkles, re: /\b(feat|feature|add|new|implement|create)\b/i },
	{ icon: FilePen, re: /\b(update|edit|change|tweak|copy|content)\b/i },
];

function taskIcon(name: string): LucideIcon {
	for (const rule of ICON_RULES) if (rule.re.test(name)) return rule.icon;
	return GitBranch;
}

// ---- sidebar task ordering ----
type TaskSortMode = "status" | "updated" | "custom";

// ---- mission control layout ----
// How agent tiles are arranged: "grid" is a 2x2 overview (tiles half the
// window wide and tall), "split" lays them side-by-side at full window
// height, "stack" stacks them full-width. Extra tiles scroll downward.
type McLayout = "grid" | "split" | "stack";

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
	const [panelMode, setPanelMode] = useState<"side" | "full">("side");
	const [projectsCollapsed, setProjectsCollapsed] = useState(false);
	const [tasksCollapsed, setTasksCollapsed] = useState(false);
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
		() => (localStorage.getItem("ateam.taskSort") as TaskSortMode) || "status",
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
	const [termByTask, setTermByTask] = useState<Record<string, string>>({});
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
	// Set up a fresh box over SSH: install() runs the (idempotent) installer on the
	// box, streaming its output via onInstallLog, and connects on success. The
	// onConnectionsChanged reconcile then folds the new box into the environment list.
	const installBox = useCallback(async (dest: string, onLog: (chunk: string) => void) => {
		const off = window.ateamHost.onInstallLog((e) => {
			if (e.dest === dest) onLog(e.chunk);
		});
		try {
			await window.ateamHost.install(dest);
		} finally {
			off();
		}
	}, []);
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
	// Sidebar list shows all tasks, including merged/done ones.
	const sidebarTasks = activeTasks;

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
		if (taskSort === "status") {
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

	// Case-insensitive substring match across the task's name, branch, and
	// description. Empty query matches all.
	const query = taskQuery.trim().toLowerCase();
	const matchesQuery = useCallback(
		(t: TaskDTO) =>
			query === "" ||
			t.name.toLowerCase().includes(query) ||
			t.branch.toLowerCase().includes(query) ||
			(t.description?.toLowerCase().includes(query) ?? false),
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
	// From the sidebar → open full width. From the board → open on the side.
	const openTask = (t: TaskDTO) => {
		setActiveProjectId(t.projectId);
		setSelectedTaskId(t.id);
		setPanelMode("full");
		setView("board");
	};
	const selectFromBoard = (id: string) => {
		setSelectedTaskId(id);
		setPanelMode("side");
	};
	// Expanding a Mission Control tile opens that exact terminal full-width.
	// `view` stays "mission", so collapsing or closing the panel lands back on
	// the grid — while the same panel opened from the Board collapses to a
	// side panel there.
	const openFromMission = (task: TaskDTO, terminalId: string) => {
		setTermByTask((m) => ({ ...m, [task.id]: terminalId }));
		setSelectedTaskId(task.id);
		setPanelMode("full");
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
														<span className="proj-envs muted" style={{ fontSize: 10 }}>
															{card.members.map((m) => aliasLabel(m.alias)).join(" · ")}
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
					<div className="task-search">
						<Search size={14} strokeWidth={1.75} />
						<input
							type="text"
							placeholder="Search tasks…"
							value={taskQuery}
							onChange={(e) => setTaskQuery(e.target.value)}
							aria-label="Search tasks"
						/>
						{taskQuery && (
							<button
								type="button"
								className="ts-clear"
								aria-label="Clear search"
								onClick={() => setTaskQuery("")}
							>
								<X size={13} strokeWidth={2} />
							</button>
						)}
					</div>
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
								order={orderedSidebarTasks.map((t) => t.id)}
								layout={mcLayout}
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
				<NewTaskComposer
					agents={agents}
					environments={composerEnvs}
					envAgents={envAgents}
					onAdd={addTailscaleBox}
					onInstall={installBox}
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
				<span className="tname">{t.name}</span>
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
						{items.map((t) => (
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
								{t.agentStatus && <span className={`ring ${t.agentStatus}`} />}
								<div className="name">{t.name}</div>
								{originLabel(t) && (
									<span className="card-env muted" style={{ fontSize: 10 }}>
										{originLabel(t)}
									</span>
								)}
								<div className="branch">{t.branch}</div>
								<div className="meta">
									{t.gitStatus && (
										<span>
											↑{t.gitStatus.ahead} ↓{t.gitStatus.behind} · {t.gitStatus.dirty} changed
										</span>
									)}
									{t.prNumber && <span>PR #{t.prNumber}</span>}
								</div>
								{t.agentId && (
									<span className="card-agent">
										<AgentIcon agentId={t.agentId} size={15} />
									</span>
								)}
							</motion.div>
						))}
					</div>
				);
			})}
		</div>
	);
}

function TaskPanel({
	task,
	agents,
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
	mode: "side" | "full";
	onSetMode: (m: "side" | "full") => void;
	/** Tooltip for the minimize button — where collapsing takes you. */
	collapseLabel?: string;
	terminalId: string | null;
	setTerminal: (tid: string) => void;
	run: (fn: () => Promise<void>) => Promise<void>;
	ask: (title: string, initial?: string) => Promise<string | null>;
	confirm: (title: string, body?: string) => Promise<boolean>;
	reload: () => void;
	onClose: (taskId?: string) => void;
}) {
	const [agentId, setAgentId] = useState(agents.find((a) => a.available)?.id ?? "claude");
	const [diff, setDiff] = useState<DiffResultDTO | null>(null);
	const [changesOpen, setChangesOpen] = useState(false);
	const [viewFile, setViewFile] = useState<string | null>(null);

	// Selecting another task closes the changes view.
	useEffect(() => {
		setChangesOpen(false);
		setViewFile(null);
	}, [task.id]);

	const refreshDiff = useCallback(() => {
		void window.ateam.git.diff(task.id).then(setDiff);
		void window.ateam.git.status(task.id);
	}, [task.id]);

	useEffect(() => {
		refreshDiff();
	}, [refreshDiff]);

	const launch = useCallback(
		(yolo: boolean, resume = false, agent = agentId) =>
			run(async () => {
				const { terminalId: tid } = await window.ateam.pty.spawnAgent({
					taskId: task.id,
					agentId: agent,
					yolo,
					resume,
				});
				setTerminal(tid);
			}),
		[task.id, agentId, run, setTerminal],
	);

	// Re-attach to a surviving daemon session when (re)opening this task. If the
	// session has ended while the task was still active work (running or awaiting
	// input), resume the agent's last conversation automatically so reopening the
	// task brings it back. Terminal columns (review/merged) are left alone — there
	// a relaunch is a deliberate act via the Resume button, not a side effect of
	// opening the task (and spawning would bounce the card back to "running").
	const autoResumedRef = useRef<string | null>(null);
	useEffect(() => {
		if (terminalId) return;
		let cancelled = false;
		void window.ateam.pty.listForTask(task.id).then((sessions) => {
			if (cancelled) return;
			if (sessions[0]) {
				setTerminal(sessions[0].terminalId);
			} else if (
				(task.column === "running" || task.column === "needs_attention") &&
				autoResumedRef.current !== task.id
			) {
				autoResumedRef.current = task.id;
				void launch(false, true, task.agentId ?? agentId);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [task.id, terminalId, task.column, task.agentId, agentId, setTerminal, launch]);

	const shell = () =>
		run(async () => {
			const { terminalId: tid } = await window.ateam.pty.spawnShell({
				taskId: task.id,
			});
			setTerminal(tid);
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
	const toggleChanges = () => {
		if (changesOpen) {
			setChangesOpen(false);
			return;
		}
		refreshDiff();
		setChangesOpen(true);
		if (!viewFile && diff?.files[0]) setViewFile(diff.files[0].path);
	};

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
				<select
					className="agent-select"
					value={agentId}
					onChange={(e) => setAgentId(e.target.value)}
				>
					{agents.map((a) => (
						<option key={a.id} value={a.id} disabled={!a.available}>
							{a.label}
							{a.available ? "" : " (not installed)"}
						</option>
					))}
				</select>
				<IconButton
					icon={Play}
					label="Launch agent (asks before dangerous actions)"
					onClick={() => launch(false)}
				/>
				<IconButton icon={Zap} label="Launch in auto mode" onClick={() => launch(true)} />
				<IconButton
					icon={History}
					label="Resume the last conversation in this worktree"
					onClick={() => launch(false, true)}
				/>
				<IconButton icon={SquareTerminal} label="Open a shell" onClick={shell} />

				<span className="tb-divider" />

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

				<span className="spacer" />
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
				<div className="term-wrap" style={{ display: changesOpen ? "none" : "flex" }}>
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
							<span className="muted">Launch an agent or shell to start a terminal</span>
						</div>
					)}
				</div>

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
	order,
	layout,
	onExpand,
}: {
	tasks: TaskDTO[];
	order: string[];
	layout: McLayout;
	onExpand: (task: TaskDTO, terminalId: string) => void;
}) {
	const [tiles, setTiles] = useState<{ task: TaskDTO; terminalId: string }[]>([]);
	const tasksRef = useRef(tasks);
	tasksRef.current = tasks;

	// Snapshot the sidebar's ordering the moment we land here, so tiles come up
	// in the same order the tasks list is showing — but freeze it: while you're
	// watching, terminals must not shuffle under you (e.g. "sort by updated"
	// would otherwise reorder live as agents emit events). Tasks that gain a
	// session after we landed (not in the snapshot) sort to the end.
	const [rank] = useState(() => new Map(order.map((id, i) => [id, i])));

	useEffect(() => {
		let cancelled = false;
		const refresh = async () => {
			const collected: { task: TaskDTO; terminalId: string }[] = [];
			for (const t of tasksRef.current) {
				const sessions = await window.ateam.pty.listForTask(t.id);
				for (const s of sessions) collected.push({ task: t, terminalId: s.terminalId });
			}
			// Stable sort by the frozen sidebar order; V8's stable sort keeps a
			// task's own sessions (and any equal-rank ties) in encounter order.
			collected.sort(
				(a, b) =>
					(rank.get(a.task.id) ?? Number.MAX_SAFE_INTEGER) -
					(rank.get(b.task.id) ?? Number.MAX_SAFE_INTEGER),
			);
			if (!cancelled) setTiles(collected);
		};
		void refresh();
		const id = setInterval(refresh, 2500);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, [rank]);

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

	return (
		<div className="mc" data-layout={layout}>
			{tiles.map(({ task, terminalId }) => (
				<div key={terminalId} className="tile">
					<div className="bar">
						<span>{task.name}</span>
						<span className="muted">· {task.branch}</span>
						<span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
							{task.agentStatus && <span className={`tstatus ${task.agentStatus}`} />}
							<IconButton
								icon={Maximize2}
								label="Expand to full width"
								size={13}
								onClick={() => onExpand(task, terminalId)}
							/>
						</span>
					</div>
					<TerminalView terminalId={terminalId} />
				</div>
			))}
		</div>
	);
}
