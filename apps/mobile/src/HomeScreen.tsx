// Project/task navigation, with the shared desktop view rules and native controls.
import {
	type Alias,
	type AteamApi,
	byLatestActivity,
	byWhatsNext,
	DEFAULT_VIEW,
	filtersSet,
	groupTasks,
	type LoopDTO,
	parseView,
	passesFilters,
	type SidebarView,
	spliceOrder,
	STATUS_RANK,
	type TaskDTO,
	type TaskSortMode,
	toggled,
} from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import { useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
	ActivityIndicator,
	Alert,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { AgentIcon } from "./AgentIcon";
import type { ScrollFadeProps } from "./scroll-fade";
import { SIDEBAR_STATUSES, SidebarViewMenu } from "./SidebarViewMenu";
import { tagsFor, taskIconName } from "./task-tags";
import { C, CONTENT_MAX } from "./theme";

/** Status dot color: the agent's state when it has one, else the column's. */
export function statusColor(t: TaskDTO | null | undefined): string {
	if (!t) return C.faint;
	if (t.preparing) return C.amber;
	switch (t.agentStatus) {
		case "running":
			return C.blue;
		case "awaiting_input":
			return C.amber;
		case "idle":
			return C.green;
		case "stopped":
			return C.faint;
	}
	switch (t.column) {
		case "needs_attention":
			return C.amber;
		case "review":
			return C.green;
		case "running":
			return C.blue;
		default:
			return C.faint;
	}
}

/** Where a task runs, for its row: its box, named only when it isn't the Lead's
 *  (the phone's home, unnamed as Local is on the desktop), and why that box's
 *  tasks are out of date, if they are (src/boxes.ts awayOf). */
export interface TaskPlace {
	box: string | null;
	away: "asleep" | "offline" | null;
}

/** The words for a task's place ("box-b", "box-b · asleep", "asleep"), or null. */
export function placeText(place: TaskPlace): string | null {
	return [place.box, place.away].filter(Boolean).join(" · ") || null;
}

/** A project in the list: a repo, on one box or several (@ateam/protocol unifyProjects). */
export interface ProjectRow {
	key: string;
	name: string;
	/** The boxes it's on, named, when the phone holds more than one; else null. */
	on: string | null;
	/** Physical projects and their machines, including projects with no tasks. */
	members: { id: string; machine: Alias; label: string }[];
}

function TaskRow({
	task,
	place,
	onPress,
	onLongPress,
	sidebar = false,
	rail = false,
	selected = false,
}: {
	task: TaskDTO;
	place: TaskPlace;
	onPress: () => void;
	onLongPress?: () => void;
	sidebar?: boolean;
	/** Desktop-style icon-only navigation; only used in the sidebar. */
	rail?: boolean;
	selected?: boolean;
}) {
	const tags = tagsFor(task);
	const where = placeText(place);
	return (
		<Pressable
			style={[
				styles.row,
				sidebar && styles.sidebarRow,
				rail && styles.railRow,
				place.away && styles.rowAway,
				selected && styles.taskActive,
			]}
			onPress={onPress}
			onLongPress={onLongPress}
			accessibilityHint={onLongPress ? "Hold to change this task’s position" : undefined}
			accessibilityRole="button"
			accessibilityLabel={rail ? [task.name, where].filter(Boolean).join(", ") : undefined}
			accessibilityState={{ selected }}
		>
			<View style={styles.icon}>
				{task.agentId ? (
					<AgentIcon agentId={task.agentId} size={16} />
				) : (
					<Feather name={taskIconName(task.name)} size={15} color={C.muted} />
				)}
			</View>
			{rail ? null : sidebar ? (
				<View style={styles.taskText}>
					<Text style={[styles.sidebarName, task.isUnread && styles.nameUnread]} numberOfLines={2}>
						{task.name}
					</Text>
					{where && (
						<Text style={styles.sidebarPlace} numberOfLines={1}>
							{where}
						</Text>
					)}
				</View>
			) : (
				<Text style={[styles.name, task.isUnread && styles.nameUnread]} numberOfLines={1}>
					{task.name}
				</Text>
			)}
			{!rail && !sidebar && tags.length > 0 && (
				<View style={styles.tags}>
					{tags.map((tag) => (
						<Text key={tag} style={styles.tag}>
							{tag}
						</Text>
					))}
				</View>
			)}
			{!rail && !sidebar && where ? (
				<Text style={styles.box} numberOfLines={1}>
					{where}
				</Text>
			) : null}
			<View style={[styles.dot, rail && styles.railDot, { backgroundColor: statusColor(task) }]} />
		</Pressable>
	);
}

function LoopRow({
	loop,
	task,
	onPress,
	sidebar = false,
	rail = false,
	selected = false,
}: {
	loop: LoopDTO;
	task: TaskDTO | null;
	onPress: () => void;
	selected?: boolean;
	sidebar?: boolean;
	/** Desktop-style icon-only navigation; only used in the sidebar. */
	rail?: boolean;
}) {
	return (
		<Pressable
			style={[
				styles.row,
				sidebar && styles.sidebarRow,
				rail && styles.railRow,
				!loop.enabled && styles.rowPaused,
				selected && styles.taskActive,
			]}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={rail ? loop.title : undefined}
			accessibilityState={{ selected }}
		>
			<View style={styles.icon}>
				<Feather name="repeat" size={15} color={C.muted} />
			</View>
			{!rail && (
				<Text style={styles.name} numberOfLines={1}>
					{loop.title}
				</Text>
			)}
			<View
				style={[
					styles.dot,
					rail && styles.railDot,
					{ backgroundColor: task ? statusColor(task) : loop.enabled ? C.blue : C.faint },
				]}
			/>
		</Pressable>
	);
}

export function HomeScreen({
	api,
	onOrder,
	projects,
	selectedKey,
	onSelectProject,
	placeOf,
	onAddProject,
	tasks,
	loops,
	loading,
	onOpenTask,
	onOpenLoops,
	onNewLoop,
	scrollProps,
	topInset = 0,
	sidebar = false,
	rail = false,
	selectedTaskId,
}: {
	api: AteamApi;
	onOrder: (ids: string[]) => void;
	projects: ProjectRow[];
	selectedKey: string | null;
	onSelectProject: (key: string) => void;
	/** Where a task runs (TaskPlace). */
	placeOf: (task: TaskDTO) => TaskPlace;
	onAddProject: () => void;
	/** The selected project's tasks (loop-owned ones are listed under Loops). */
	tasks: TaskDTO[];
	loops: LoopDTO[];
	loading: boolean;
	onOpenTask: (task: TaskDTO) => void;
	onOpenLoops: () => void;
	onNewLoop: () => void;
	/** The list's scrolling, for what floats over it (scroll-fade.ts). */
	scrollProps?: ScrollFadeProps;
	/** The floating top bar's height: the list scrolls under it and starts below it. */
	topInset?: number;
	/** Reuse Home as persistent navigation in a wide window. */
	sidebar?: boolean;
	/** Desktop-style icon-only navigation; only used in the sidebar. */
	rail?: boolean;
	selectedTaskId?: string;
}) {
	const [prefs, setPrefs] = useState<{ view: SidebarView; sort: TaskSortMode; order: string[] }>({
		view: DEFAULT_VIEW,
		sort: "updated",
		order: [],
	});
	const { view, sort } = prefs;
	const [projectsOpen, setProjectsOpen] = useState(true);
	const [tasksOpen, setTasksOpen] = useState(true);
	const [loopsOpen, setLoopsOpen] = useState(true);
	const [archived, setArchived] = useState<TaskDTO[]>([]);
	const [archiveError, setArchiveError] = useState<string | null>(null);
	const [readError, setReadError] = useState<string | null>(null);
	const [marking, setMarking] = useState(false);
	const [readAt, setReadAt] = useState<Record<string, number | null>>({});
	const touched = useRef(false);
	const storageKey = `ateam.sidebarView.${selectedKey ?? "none"}`;
	useEffect(() => {
		let cancelled = false;
		void AsyncStorage.getItem(storageKey)
			.then((raw) => {
				if (cancelled || touched.current || !raw) return;
				const parsed: unknown = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
				const p = parsed as Record<string, unknown>;
				setPrefs({
					view: parseView(JSON.stringify(p.view)),
					sort: ["next", "status", "updated", "custom"].includes(String(p.sort))
						? (p.sort as TaskSortMode)
						: "updated",
					order: Array.isArray(p.order)
						? p.order.filter((id): id is string => typeof id === "string")
						: [],
				});
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [storageKey]);
	const change = (patch: Partial<typeof prefs>) => {
		touched.current = true;
		const next = { ...prefs, ...patch };
		setPrefs(next);
		void AsyncStorage.setItem(storageKey, JSON.stringify(next)).catch(() => {});
	};
	const members = projects.find((p) => p.key === selectedKey)?.members ?? [];
	const projectIds = members
		.map((m) => m.id)
		.sort()
		.join(" ");
	useEffect(() => {
		if (!view.showArchived) {
			setArchived([]);
			setArchiveError(null);
			return;
		}
		let cancelled = false;
		let running = false;
		const refresh = async () => {
			if (running) return;
			running = true;
			const ids = projectIds ? projectIds.split(" ") : [];
			const results = await Promise.allSettled(ids.map((id) => api.tasks.listArchived(id)));
			running = false;
			if (cancelled) return;
			const failed = new Set(results.flatMap((r, i) => (r.status === "rejected" ? [ids[i]] : [])));
			const arrived = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
			setArchived((prev) => [...prev.filter((t) => failed.has(t.projectId)), ...arrived]);
			setArchiveError(failed.size ? "Could not load archived tasks from every machine." : null);
		};
		void refresh();
		const off = api.events.onTaskUpdated(() => void refresh());
		return () => {
			cancelled = true;
			off();
		};
	}, [api, projectIds, view.showArchived]);
	const loopTaskIds = useMemo(() => new Set(loops.map((l) => l.taskId).filter(Boolean)), [loops]);
	const ordered = useMemo(() => {
		const all = [
			...new Map([...tasks, ...(view.showArchived ? archived : [])].map((t) => [t.id, t])).values(),
		]
			.filter((t) => !loopTaskIds.has(t.id))
			.map((t) =>
				t.id in readAt && readAt[t.id] === t.lastEventAt ? { ...t, isUnread: false } : t,
			);
		if (sort === "next") all.sort(byWhatsNext);
		else if (sort === "status") all.sort((a, b) => STATUS_RANK[a.column] - STATUS_RANK[b.column]);
		else if (sort === "updated") all.sort(byLatestActivity);
		else {
			const rank = new Map(prefs.order.map((id, i) => [id, i]));
			all.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
		}
		return all;
	}, [tasks, archived, view.showArchived, loopTaskIds, sort, prefs.order, readAt]);
	const orderIds = ordered.map((t) => t.id).join(" ");
	useEffect(() => {
		onOrder(orderIds ? orderIds.split(" ") : []);
	}, [orderIds, onOrder]);
	const machines = [
		...new Map(members.map((m) => [m.machine, { id: m.machine, label: m.label }])).values(),
	];
	const machineOf = (t: TaskDTO) => members.find((m) => m.id === t.projectId)?.machine ?? null;
	const filtered = ordered.filter((t) => passesFilters(t, view, machineOf));
	const groups = groupTasks(filtered, view.grouping, {
		machineOf,
		machineLabel: (id) => machines.find((m) => m.id === id)?.label ?? "Home box",
		statusLabel: (key) => SIDEBAR_STATUSES.find((s) => s.value === key)?.label ?? key,
		now: Date.now(),
	});
	const groupKeys = groups.filter((g) => g.label).map((g) => g.key);
	const lit = filtersSet(
		view,
		machines.map((m) => m.id),
	);
	const unread = filtered.filter((t) => t.isUnread);
	const markAllRead = async () => {
		setMarking(true);
		setReadError(null);
		const results = await Promise.allSettled(unread.map((t) => api.tasks.markRead(t.id)));
		setReadAt((prev) => ({
			...prev,
			...Object.fromEntries(
				results.flatMap((r) =>
					r.status === "fulfilled" ? [[r.value.id, r.value.lastEventAt]] : [],
				),
			),
		}));
		if (results.some((r) => r.status === "rejected"))
			setReadError(
				"Some tasks could not be marked as read. Try again when their machine is online.",
			);
		setMarking(false);
	};
	const moveTask = (task: TaskDTO, group: TaskDTO[]) => {
		const index = group.findIndex((t) => t.id === task.id);
		const move = (delta: number) => {
			const ids = group.map((t) => t.id);
			const other = ids[index + delta];
			if (!other) return;
			ids[index + delta] = task.id;
			ids[index] = other;
			change({
				order: spliceOrder(
					ordered.map((t) => t.id),
					ids,
				),
			});
		};
		Alert.alert(task.name, "Move within this group", [
			...(index > 0 ? [{ text: "Move up", onPress: () => move(-1) }] : []),
			...(index < group.length - 1 ? [{ text: "Move down", onPress: () => move(1) }] : []),
			{ text: "Cancel", style: "cancel" },
		]);
	};
	const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

	return (
		<ScrollView
			style={styles.root}
			keyboardShouldPersistTaps="handled"
			contentContainerStyle={[styles.content, { paddingTop: topInset + 6 }]}
			scrollIndicatorInsets={{ top: topInset }}
			{...scrollProps}
		>
			<View style={styles.column}>
				<View style={[styles.sectionHead, rail && styles.railSectionHead]}>
					{!rail && (
						<Pressable
							style={[styles.sectionToggle, sidebar && styles.sidebarHit]}
							onPress={() => setProjectsOpen((o) => !o)}
							accessibilityRole="button"
							accessibilityLabel="Projects"
							accessibilityState={{ expanded: projectsOpen }}
						>
							<Feather
								name={projectsOpen ? "chevron-down" : "chevron-right"}
								size={14}
								color={C.muted}
							/>
							<Text style={styles.sectionTitle}>Projects</Text>
						</Pressable>
					)}
					<Pressable
						style={[styles.sortBtn, sidebar && styles.sidebarHit]}
						onPress={onAddProject}
						hitSlop={6}
						accessibilityLabel="Add project"
						accessibilityRole="button"
					>
						<Feather name="folder-plus" size={16} color={C.muted} />
					</Pressable>
				</View>
				{(rail || projectsOpen) &&
					(projects.length === 0
						? !rail && <Text style={styles.emptyText}>No projects yet</Text>
						: projects.map((p) => {
								const active = p.key === selectedKey;
								return (
									<Pressable
										key={p.key}
										style={[
											styles.row,
											sidebar && styles.sidebarRow,
											rail && styles.railRow,
											active && styles.rowActive,
										]}
										onPress={() => onSelectProject(p.key)}
										accessibilityLabel={
											rail ? [p.name, p.on].filter(Boolean).join(", ") : undefined
										}
										accessibilityRole="button"
										accessibilityState={{ selected: active }}
									>
										<View style={styles.icon}>
											{rail ? (
												<Text style={styles.railInitial}>{p.name.charAt(0).toUpperCase()}</Text>
											) : (
												<View style={[styles.projDot, active && styles.projDotActive]} />
											)}
										</View>
										{!rail && (
											<Text style={[styles.name, active && styles.nameActive]} numberOfLines={1}>
												{p.name}
											</Text>
										)}
										{!rail && p.on ? (
											<Text style={styles.box} numberOfLines={1}>
												{p.on}
											</Text>
										) : null}
									</Pressable>
								);
							}))}

				<View style={[styles.sectionHead, styles.sectionHeadLower, rail && styles.railSectionHead]}>
					{!rail && (
						<Pressable
							style={[styles.sectionToggle, sidebar && styles.sidebarHit]}
							onPress={() => setTasksOpen((o) => !o)}
							accessibilityRole="button"
							accessibilityLabel="Tasks"
							accessibilityState={{ expanded: tasksOpen }}
						>
							<Feather
								name={tasksOpen ? "chevron-down" : "chevron-right"}
								size={14}
								color={C.muted}
							/>
							<Text style={styles.sectionTitle}>Tasks</Text>
						</Pressable>
					)}
					<SidebarViewMenu
						view={view}
						onView={(view) => change({ view })}
						sort={sort}
						onSort={(sort) =>
							change({ sort, ...(sort === "custom" ? { order: ordered.map((t) => t.id) } : {}) })
						}
						machines={machines}
						groupKeys={groupKeys}
						unread={unread.length}
						onMarkAllRead={() => void markAllRead()}
						marking={marking}
						error={archiveError ?? readError}
					/>
				</View>
				{(archiveError || readError) && !rail && (
					<Text style={styles.emptyText}>{archiveError ?? readError}</Text>
				)}
				{(rail || tasksOpen) &&
					(loading && ordered.length === 0 ? (
						<View style={styles.empty}>
							<ActivityIndicator color={C.muted} />
						</View>
					) : filtered.length === 0 ? (
						!rail && (
							<Text style={styles.emptyText}>
								{lit ? "No tasks match these filters" : "No active tasks"}
							</Text>
						)
					) : (
						groups.map((group) => (
							<View key={group.key}>
								{group.label && !rail && (
									<Pressable
										style={styles.groupHead}
										onPress={() =>
											change({ view: { ...view, collapsed: toggled(view.collapsed, group.key) } })
										}
										accessibilityRole="button"
										accessibilityLabel={group.label}
										accessibilityState={{ expanded: !view.collapsed.includes(group.key) }}
									>
										<Feather
											name={view.collapsed.includes(group.key) ? "chevron-right" : "chevron-down"}
											size={12}
											color={C.muted}
										/>
										<Text style={styles.groupLabel}>{group.label}</Text>
										<Text style={styles.groupLabel}>{group.tasks.length}</Text>
									</Pressable>
								)}
								{(rail || !view.collapsed.includes(group.key)) &&
									group.tasks.map((t) => (
										<TaskRow
											key={t.id}
											task={t}
											place={placeOf(t)}
											onPress={() => onOpenTask(t)}
											onLongPress={
												sort === "custom" && group.tasks.length > 1
													? () => moveTask(t, group.tasks)
													: undefined
											}
											sidebar={sidebar}
											rail={rail}
											selected={t.id === selectedTaskId}
										/>
									))}
							</View>
						))
					))}
				<View style={[styles.sectionHead, styles.sectionHeadLower, rail && styles.railSectionHead]}>
					{!rail && (
						<Pressable
							style={[styles.sectionToggle, sidebar && styles.sidebarHit]}
							onPress={() => setLoopsOpen((o) => !o)}
							accessibilityRole="button"
							accessibilityLabel="Loops"
							accessibilityState={{ expanded: loopsOpen }}
						>
							<Feather
								name={loopsOpen ? "chevron-down" : "chevron-right"}
								size={14}
								color={C.muted}
							/>
							<Text style={styles.sectionTitle}>Loops</Text>
						</Pressable>
					)}
					<Pressable
						style={[styles.sortBtn, sidebar && styles.sidebarHit]}
						onPress={onNewLoop}
						hitSlop={6}
						accessibilityLabel="New loop"
						accessibilityRole="button"
					>
						<Feather name="plus" size={16} color={C.muted} />
					</Pressable>
				</View>
				{(rail || loopsOpen) &&
					(loops.length === 0
						? !rail && <Text style={styles.emptyText}>No loops</Text>
						: loops.map((l) => {
								const task = l.taskId ? (taskById.get(l.taskId) ?? null) : null;
								return (
									<LoopRow
										key={l.id}
										loop={l}
										sidebar={sidebar}
										rail={rail}
										task={task}
										selected={!!task && task.id === selectedTaskId}
										onPress={() => (task ? onOpenTask(task) : onOpenLoops())}
									/>
								);
							}))}
			</View>
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	groupHead: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		paddingHorizontal: 16,
		minHeight: 44,
	},
	groupLabel: { color: C.muted, fontSize: 11 },
	root: { flex: 1, backgroundColor: C.bg },
	content: { paddingVertical: 6, paddingBottom: 24 },
	column: { width: "100%", maxWidth: CONTENT_MAX, alignSelf: "center" },
	sectionHead: {
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 12,
		paddingVertical: 8,
	},
	sectionHeadLower: { marginTop: 14 },
	sectionToggle: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6 },
	sectionTitle: {
		color: C.muted,
		fontSize: 11,
		fontWeight: "700",
		letterSpacing: 1.2,
		textTransform: "uppercase",
	},
	sortBtn: {
		paddingHorizontal: 8,
		height: 26,
		borderRadius: 6,
		alignItems: "center",
		justifyContent: "center",
	},
	sortText: { color: C.muted, fontSize: 12, fontWeight: "600" },
	row: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingHorizontal: 14,
		paddingVertical: 11,
	},
	rowPaused: { opacity: 0.5 },
	// From a box that's asleep or not answering: its board as last seen.
	rowAway: { opacity: 0.55 },
	rowActive: { backgroundColor: C.surface },
	taskActive: { backgroundColor: C.sunken },
	taskText: { flex: 1, minWidth: 0, gap: 3 },
	sidebarName: { color: C.ink, fontSize: 14 },
	sidebarPlace: { color: C.faint, fontSize: 12 },
	sidebarHit: { minHeight: 44, minWidth: 44 },
	sidebarRow: { minHeight: 44 },
	railRow: { paddingHorizontal: 0, justifyContent: "center", gap: 0 },
	railDot: { position: "absolute", top: 8, right: 8, width: 6, height: 6 },
	railInitial: { color: C.ink, fontSize: 15, fontWeight: "700", textAlign: "center" },
	railSectionHead: {
		paddingHorizontal: 0,
		paddingVertical: 4,
		justifyContent: "center",
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: C.line,
	},
	projDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.line },
	projDotActive: { backgroundColor: C.ink },
	nameActive: { fontWeight: "700" },
	icon: { width: 20, alignItems: "center" },
	name: { flex: 1, color: C.ink, fontSize: 15 },
	nameUnread: { fontWeight: "700" },
	tags: { flexDirection: "row", gap: 4 },
	tag: {
		color: C.muted,
		fontSize: 10,
		fontWeight: "600",
		paddingHorizontal: 6,
		paddingVertical: 2,
		borderRadius: 5,
		backgroundColor: C.sunken,
		overflow: "hidden",
	},
	dot: { width: 8, height: 8, borderRadius: 4 },
	box: { flexShrink: 1, maxWidth: "40%", color: C.faint, fontSize: 12 },
	empty: { paddingVertical: 20, alignItems: "center" },
	emptyText: { color: C.faint, fontSize: 13, paddingHorizontal: 14, paddingVertical: 10 },
});
