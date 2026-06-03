import {
	ArrowDownToLine,
	ArrowUp,
	BookOpen,
	Brush,
	Bug,
	ChevronDown,
	ChevronRight,
	Database,
	FilePen,
	FlaskConical,
	FolderPlus,
	Gauge,
	GitBranch,
	GitCommitVertical,
	GitMerge,
	History,
	Lock,
	type LucideIcon,
	Maximize2,
	Minimize2,
	Palette,
	Play,
	Plus,
	RotateCw,
	Rocket,
	Server,
	Sparkles,
	SquareTerminal,
	Trash2,
	Wrench,
	X,
	Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
	AgentDTO,
	DiffResultDTO,
	KanbanColumn,
	ProjectDTO,
	TaskDTO,
} from "../../shared/types";
import { AgentIcon } from "./components/AgentIcon";
import { CleanupDialog } from "./components/CleanupDialog";
import { IconButton } from "./components/IconButton";
import { Menu } from "./components/Menu";
import { TerminalView } from "./components/Terminal";
import { usePrompt } from "./components/usePrompt";

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

export function App() {
	const [projects, setProjects] = useState<ProjectDTO[]>([]);
	const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
	const [tasksByProject, setTasksByProject] = useState<
		Record<string, TaskDTO[]>
	>({});
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
	const [agents, setAgents] = useState<AgentDTO[]>([]);
	const [view, setView] = useState<"board" | "mission">("board");
	const [panelMode, setPanelMode] = useState<"side" | "full">("side");
	const [projectsCollapsed, setProjectsCollapsed] = useState(false);
	const [tasksCollapsed, setTasksCollapsed] = useState(false);
	const [cleanupOpen, setCleanupOpen] = useState(false);
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
		const list = await window.grove.tasks.list(projectId);
		setTasksByProject((prev) => ({ ...prev, [projectId]: list }));
	}, []);

	const loadProjects = useCallback(async () => {
		const list = await window.grove.projects.list();
		setProjects(list);
		setActiveProjectId((cur) => cur ?? list[0]?.id ?? null);
	}, []);

	useEffect(() => {
		void loadProjects();
		void window.grove.agents.list().then(setAgents);
		const off = window.grove.events.onTaskUpdated((updated) => {
			setTasksByProject((prev) => {
				const next: Record<string, TaskDTO[]> = {};
				for (const [pid, list] of Object.entries(prev)) {
					next[pid] = list.map((t) => (t.id === updated.id ? updated : t));
				}
				return next;
			});
		});
		return off;
	}, [loadProjects]);

	// Load the selected project's tasks whenever it changes.
	useEffect(() => {
		if (activeProjectId) void loadTasks(activeProjectId);
	}, [activeProjectId, loadTasks]);

	const activeTasks = activeProjectId
		? (tasksByProject[activeProjectId] ?? [])
		: [];
	const selectedTask = activeTasks.find((t) => t.id === selectedTaskId) ?? null;
	// "Active" tasks for the sidebar list = everything not yet merged/done.
	const sidebarTasks = activeTasks.filter((t) => t.column !== "merged");

	const selectProject = (id: string) => setActiveProjectId(id);
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

	const addProject = () =>
		run(async () => {
			const path = await window.grove.projects.pick();
			if (!path) return;
			const proj = await window.grove.projects.register(path);
			await loadProjects();
			selectProject(proj.id);
		});

	const newTask = () =>
		run(async () => {
			if (!activeProjectId) return;
			const name = await ask("New task name");
			if (!name) return;
			const task = await window.grove.tasks.create({
				projectId: activeProjectId,
				name,
			});
			await loadTasks(activeProjectId);
			setSelectedTaskId(task.id);
		});

	const cleanup = () => {
		if (activeProjectId) setCleanupOpen(true);
	};

	return (
		<div className="app">
			<aside className="sidebar">
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
					projects.map((p) => (
						<button
							type="button"
							key={p.id}
							className={`proj ${p.id === activeProjectId ? "active" : ""}`}
							onClick={() => selectProject(p.id)}
						>
							<span
								className="dot"
								style={p.color ? { background: p.color } : undefined}
							/>
							<span className="proj-name" title={p.repoPath}>
								{p.name}
							</span>
						</button>
					))}

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
					<IconButton
						icon={Plus}
						label="New task"
						onClick={newTask}
						disabled={!activeProjectId}
					/>
				</div>
				{!tasksCollapsed &&
					(!activeProjectId ? (
						<div className="tree-empty">Select a project</div>
					) : sidebarTasks.length === 0 ? (
						<div className="tree-empty">No active tasks</div>
					) : (
						sidebarTasks.map((t) => {
							const Icon = taskIcon(t.name);
							return (
								<button
									type="button"
									key={t.id}
									className={`tasknode ${t.id === selectedTaskId ? "selected" : ""}`}
									onClick={() => openTask(t)}
								>
									{t.agentId ? (
										<span className="ticon">
											<AgentIcon agentId={t.agentId} size={14} />
										</span>
									) : (
										<Icon className="ticon" size={14} strokeWidth={1.75} />
									)}
									<span className="tname">{t.name}</span>
									{t.agentStatus && (
										<span className={`tstatus ${t.agentStatus}`} />
									)}
								</button>
							);
						})
					))}
			</aside>

			<main className="main">
				<div className="topbar">
					<div className="tabs">
						<div
							className={`tab ${view === "board" ? "active" : ""}`}
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
							onClick={() => setView("mission")}
						>
							Mission Control
						</div>
					</div>
					<div className="spacer" />
					<button
						type="button"
						className="navbtn"
						onClick={cleanup}
						disabled={!activeProjectId}
					>
						<Brush size={14} strokeWidth={1.75} />
						Clean up
					</button>
					<button
						type="button"
						className="navbtn"
						onClick={newTask}
						disabled={!activeProjectId}
					>
						<Plus size={14} strokeWidth={1.75} />
						New task
					</button>
				</div>

				<div className="content">
					{view === "board" ? (
						<>
							{!(selectedTask && panelMode === "full") && (
								<Board
									tasks={activeTasks}
									selectedId={selectedTaskId}
									onSelect={selectFromBoard}
									onDeselect={() => setSelectedTaskId(null)}
								/>
							)}
							{selectedTask && (
								<TaskPanel
									task={selectedTask}
									agents={agents}
									mode={panelMode}
									onSetMode={setPanelMode}
									terminalId={termByTask[selectedTask.id] ?? null}
									setTerminal={(tid) =>
										setTermByTask((m) => ({ ...m, [selectedTask.id]: tid }))
									}
									run={run}
									ask={ask}
									confirm={confirm}
									reload={() => activeProjectId && loadTasks(activeProjectId)}
									onClose={() => setSelectedTaskId(null)}
								/>
							)}
						</>
					) : (
						<MissionControl tasks={activeTasks} />
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

function Board({
	tasks,
	selectedId,
	onSelect,
	onDeselect,
}: {
	tasks: TaskDTO[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	onDeselect: () => void;
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
							<div
								key={t.id}
								className={`card ${t.id === selectedId ? "selected" : ""}`}
								onClick={(e) => {
									e.stopPropagation();
									onSelect(t.id);
								}}
							>
								{t.agentStatus && <span className={`ring ${t.agentStatus}`} />}
								<div className="name">{t.name}</div>
								<div className="branch">{t.branch}</div>
								<div className="meta">
									{t.gitStatus && (
										<span>
											↑{t.gitStatus.ahead} ↓{t.gitStatus.behind} ·{" "}
											{t.gitStatus.dirty} changed
										</span>
									)}
									{t.prNumber && <span>PR #{t.prNumber}</span>}
								</div>
								{t.agentId && (
									<span className="card-agent">
										<AgentIcon agentId={t.agentId} size={15} />
									</span>
								)}
							</div>
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
	terminalId: string | null;
	setTerminal: (tid: string) => void;
	run: (fn: () => Promise<void>) => Promise<void>;
	ask: (title: string, initial?: string) => Promise<string | null>;
	confirm: (title: string, body?: string) => Promise<boolean>;
	reload: () => void;
	onClose: () => void;
}) {
	const [agentId, setAgentId] = useState(
		agents.find((a) => a.available)?.id ?? "claude",
	);
	const [diff, setDiff] = useState<DiffResultDTO | null>(null);

	const refreshDiff = useCallback(() => {
		void window.grove.git.diff(task.id).then(setDiff);
		void window.grove.git.status(task.id);
	}, [task.id]);

	useEffect(() => {
		refreshDiff();
	}, [refreshDiff]);

	// Re-attach to a surviving daemon session when (re)opening this task.
	useEffect(() => {
		if (terminalId) return;
		let cancelled = false;
		void window.grove.pty.listForTask(task.id).then((sessions) => {
			if (!cancelled && sessions[0]) setTerminal(sessions[0].terminalId);
		});
		return () => {
			cancelled = true;
		};
	}, [task.id, terminalId, setTerminal]);

	const launch = (yolo: boolean, resume = false) =>
		run(async () => {
			const { terminalId: tid } = await window.grove.pty.spawnAgent({
				taskId: task.id,
				agentId,
				yolo,
				resume,
			});
			setTerminal(tid);
		});

	const shell = () =>
		run(async () => {
			const { terminalId: tid } = await window.grove.pty.spawnShell({
				taskId: task.id,
			});
			setTerminal(tid);
		});

	const commit = () =>
		run(async () => {
			const msg = await ask("Commit message");
			if (!msg) return;
			await window.grove.git.commit(task.id, msg);
			refreshDiff();
		});

	return (
		<section className={`panel ${mode === "full" ? "full" : ""}`}>
			<div className="head">
				<div style={{ display: "flex", justifyContent: "space-between" }}>
					<span className="title">{task.name}</span>
					<span style={{ display: "flex", gap: 2 }}>
						{mode === "full" ? (
							<IconButton
								icon={Minimize2}
								label="Show beside the board"
								onClick={() => onSetMode("side")}
							/>
						) : (
							<IconButton
								icon={Maximize2}
								label="Expand to full width"
								onClick={() => onSetMode("full")}
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
				<IconButton
					icon={Zap}
					label="Launch in YOLO mode — bypass all permissions"
					onClick={() => launch(true)}
				/>
				<IconButton
					icon={History}
					label="Resume the last conversation in this worktree"
					onClick={() => launch(false, true)}
				/>
				<IconButton icon={SquareTerminal} label="Open a shell" onClick={shell} />

				<span className="tb-divider" />

				<IconButton
					icon={GitCommitVertical}
					label="Commit all changes"
					onClick={commit}
				/>
				<IconButton
					icon={ArrowUp}
					label="Push branch to origin"
					onClick={() => run(() => window.grove.git.push(task.id))}
				/>
				<IconButton
					icon={ArrowDownToLine}
					label="Update from base branch"
					onClick={() =>
						run(async () => {
							await window.grove.git.update(task.id);
							refreshDiff();
						})
					}
				/>
				<IconButton
					icon={GitMerge}
					label="Merge via PR (squash) + update local main"
					onClick={() =>
						run(async () => {
							await window.grove.git.merge(task.id, "squash");
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
									await window.grove.tasks.remove({
										id: task.id,
										deleteBranch: true,
									});
								} catch (e) {
									const msg = e instanceof Error ? e.message : String(e);
									if (
										/modified or untracked|not fully merged|use --force/i.test(
											msg,
										)
									) {
										const ok = await confirm(
											"Force delete?",
											"This worktree has uncommitted/untracked changes or an unmerged branch. Delete it anyway?",
										);
										if (!ok) return;
										await run(() =>
											window.grove.tasks.remove({
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
								onClose();
								reload();
							},
						},
					]}
				/>
			</div>

			{terminalId ? (
				<TerminalView terminalId={terminalId} />
			) : (
				<div className="term" style={{ display: "grid", placeItems: "center" }}>
					<span className="muted">Launch an agent or shell to start a terminal</span>
				</div>
			)}

			<div className="diff">
				<div style={{ display: "flex", justifyContent: "space-between" }}>
					<strong>Changes vs {task.baseBranch}</strong>
					<IconButton icon={RotateCw} label="Refresh diff" onClick={refreshDiff} />
				</div>
				{diff?.files.length ? (
					diff.files.map((f) => (
						<div className="file" key={f.path}>
							<span>{f.path}</span>
							<span>
								<span className="add">+{f.additions}</span>{" "}
								<span className="del">-{f.deletions}</span>
							</span>
						</div>
					))
				) : (
					<div className="muted" style={{ padding: "4px 0" }}>
						No changes
					</div>
				)}
			</div>
		</section>
	);
}

function MissionControl({ tasks }: { tasks: TaskDTO[] }) {
	const [tiles, setTiles] = useState<{ task: TaskDTO; terminalId: string }[]>(
		[],
	);
	const tasksRef = useRef(tasks);
	tasksRef.current = tasks;

	useEffect(() => {
		let cancelled = false;
		const refresh = async () => {
			const collected: { task: TaskDTO; terminalId: string }[] = [];
			for (const t of tasksRef.current) {
				const sessions = await window.grove.pty.listForTask(t.id);
				for (const s of sessions)
					collected.push({ task: t, terminalId: s.terminalId });
			}
			if (!cancelled) setTiles(collected);
		};
		void refresh();
		const id = setInterval(refresh, 2500);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, []);

	if (tiles.length === 0) {
		return (
			<div className="mc">
				<div className="empty">
					No live agents yet.
					<br />
					Launch agents from the Board to watch them work side by side here.
				</div>
			</div>
		);
	}

	return (
		<div className="mc">
			{tiles.map(({ task, terminalId }) => (
				<div
					key={terminalId}
					className={`tile ${task.agentStatus === "awaiting_input" ? "attention" : ""}`}
				>
					<div className="bar">
						{task.agentStatus && <span className={`ring ${task.agentStatus}`} />}
						<span>{task.name}</span>
						<span className="muted">· {task.branch}</span>
					</div>
					<TerminalView terminalId={terminalId} />
				</div>
			))}
		</div>
	);
}
