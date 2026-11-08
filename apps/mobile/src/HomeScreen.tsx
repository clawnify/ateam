// Home: the desktop sidebar as a phone list. Projects from every box (one row per
// repo, however many boxes it's on), a Tasks section, last updated
// first (tap the header to switch to status order: Review, Needs You, In
// Progress, Backlog), and a Loops section below, each row
// an icon, a name and a status dot. Tap a task for its terminal; tap a loop for
// its task's terminal, or the Loops tab if it has never run.
import type { LoopDTO, TaskDTO } from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { AgentIcon } from "./AgentIcon";
import type { ScrollFadeProps } from "./scroll-fade";
import { sortTasks, type TaskSort } from "./task-order";
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
}

function TaskRow({
	task,
	place,
	onPress,
	sidebar = false,
	selected = false,
}: {
	task: TaskDTO;
	place: TaskPlace;
	onPress: () => void;
	sidebar?: boolean;
	selected?: boolean;
}) {
	const tags = tagsFor(task);
	const where = placeText(place);
	return (
		<Pressable
			style={[
				styles.row,
				sidebar && styles.sidebarRow,
				place.away && styles.rowAway,
				selected && styles.taskActive,
			]}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityState={{ selected }}
		>
			<View style={styles.icon}>
				{task.agentId ? (
					<AgentIcon agentId={task.agentId} size={16} />
				) : (
					<Feather name={taskIconName(task.name)} size={15} color={C.muted} />
				)}
			</View>
			{sidebar ? (
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
			{!sidebar && tags.length > 0 && (
				<View style={styles.tags}>
					{tags.map((tag) => (
						<Text key={tag} style={styles.tag}>
							{tag}
						</Text>
					))}
				</View>
			)}
			{!sidebar && where ? (
				<Text style={styles.box} numberOfLines={1}>
					{where}
				</Text>
			) : null}
			<View style={[styles.dot, { backgroundColor: statusColor(task) }]} />
		</Pressable>
	);
}

function LoopRow({
	loop,
	task,
	onPress,
	sidebar = false,
	selected = false,
}: {
	loop: LoopDTO;
	task: TaskDTO | null;
	onPress: () => void;
	selected?: boolean;
	sidebar?: boolean;
}) {
	return (
		<Pressable
			style={[
				styles.row,
				sidebar && styles.sidebarRow,
				!loop.enabled && styles.rowPaused,
				selected && styles.taskActive,
			]}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityState={{ selected }}
		>
			<View style={styles.icon}>
				<Feather name="repeat" size={15} color={C.muted} />
			</View>
			<Text style={styles.name} numberOfLines={1}>
				{loop.title}
			</Text>
			<View
				style={[
					styles.dot,
					{ backgroundColor: task ? statusColor(task) : loop.enabled ? C.blue : C.faint },
				]}
			/>
		</Pressable>
	);
}

export function HomeScreen({
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
	selectedTaskId,
}: {
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
	selectedTaskId?: string;
}) {
	const [sort, setSort] = useState<TaskSort>("updated");
	const [projectsOpen, setProjectsOpen] = useState(true);
	const [tasksOpen, setTasksOpen] = useState(true);
	const [loopsOpen, setLoopsOpen] = useState(true);
	const loopTaskIds = useMemo(() => new Set(loops.map((l) => l.taskId).filter(Boolean)), [loops]);
	const ordered = useMemo(
		() =>
			sortTasks(
				tasks.filter((t) => !loopTaskIds.has(t.id)),
				sort,
			),
		[tasks, loopTaskIds, sort],
	);
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
				<View style={styles.sectionHead}>
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
				{projectsOpen &&
					(projects.length === 0 ? (
						<Text style={styles.emptyText}>No projects yet</Text>
					) : (
						projects.map((p) => {
							const active = p.key === selectedKey;
							return (
								<Pressable
									key={p.key}
									style={[styles.row, sidebar && styles.sidebarRow, active && styles.rowActive]}
									onPress={() => onSelectProject(p.key)}
									accessibilityRole="button"
									accessibilityState={{ selected: active }}
								>
									<View style={styles.icon}>
										<View style={[styles.projDot, active && styles.projDotActive]} />
									</View>
									<Text style={[styles.name, active && styles.nameActive]} numberOfLines={1}>
										{p.name}
									</Text>
									{p.on ? (
										<Text style={styles.box} numberOfLines={1}>
											{p.on}
										</Text>
									) : null}
								</Pressable>
							);
						})
					))}

				<View style={[styles.sectionHead, styles.sectionHeadLower]}>
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
					<Pressable
						style={[styles.sortBtn, sidebar && styles.sidebarHit]}
						onPress={() => setSort((s) => (s === "status" ? "updated" : "status"))}
						accessibilityRole="button"
						accessibilityLabel={`Sort tasks by ${sort === "status" ? "recent activity" : "status"}`}
						hitSlop={6}
					>
						<Text style={styles.sortText}>{sort === "status" ? "by status" : "recent"}</Text>
					</Pressable>
				</View>
				{tasksOpen &&
					(loading && ordered.length === 0 ? (
						<View style={styles.empty}>
							<ActivityIndicator color={C.muted} />
						</View>
					) : ordered.length === 0 ? (
						<Text style={styles.emptyText}>No active tasks</Text>
					) : (
						ordered.map((t) => (
							<TaskRow
								key={t.id}
								task={t}
								place={placeOf(t)}
								onPress={() => onOpenTask(t)}
								sidebar={sidebar}
								selected={t.id === selectedTaskId}
							/>
						))
					))}

				<View style={[styles.sectionHead, styles.sectionHeadLower]}>
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
				{loopsOpen &&
					(loops.length === 0 ? (
						<Text style={styles.emptyText}>No loops</Text>
					) : (
						loops.map((l) => {
							const task = l.taskId ? (taskById.get(l.taskId) ?? null) : null;
							return (
								<LoopRow
									key={l.id}
									loop={l}
									sidebar={sidebar}
									task={task}
									selected={!!task && task.id === selectedTaskId}
									onPress={() => (task ? onOpenTask(task) : onOpenLoops())}
								/>
							);
						})
					))}
			</View>
		</ScrollView>
	);
}

const styles = StyleSheet.create({
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
