// Home: the desktop sidebar as a phone list. A Tasks section in status order
// (Review, Needs You, In Progress, Backlog) and a Loops section below, each row
// an icon, a name and a status dot. Tap a task for its terminal; tap a loop for
// its task's terminal, or the Loops tab if it has never run.
import type { LoopDTO, ProjectDTO, TaskDTO } from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { AgentIcon } from "./AgentIcon";
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

function TaskRow({ task, onPress }: { task: TaskDTO; onPress: () => void }) {
	const tags = tagsFor(task);
	return (
		<Pressable style={styles.row} onPress={onPress}>
			<View style={styles.icon}>
				{task.agentId ? (
					<AgentIcon agentId={task.agentId} size={16} />
				) : (
					<Feather name={taskIconName(task.name)} size={15} color={C.muted} />
				)}
			</View>
			<Text style={[styles.name, task.isUnread && styles.nameUnread]} numberOfLines={1}>
				{task.name}
			</Text>
			{tags.length > 0 && (
				<View style={styles.tags}>
					{tags.map((tag) => (
						<Text key={tag} style={styles.tag}>
							{tag}
						</Text>
					))}
				</View>
			)}
			<View style={[styles.dot, { backgroundColor: statusColor(task) }]} />
		</Pressable>
	);
}

function LoopRow({
	loop,
	task,
	onPress,
}: {
	loop: LoopDTO;
	task: TaskDTO | null;
	onPress: () => void;
}) {
	return (
		<Pressable style={[styles.row, !loop.enabled && styles.rowPaused]} onPress={onPress}>
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
	selectedProjectId,
	onSelectProject,
	onAddProject,
	tasks,
	loops,
	loading,
	onOpenTask,
	onOpenLoops,
	onNewLoop,
}: {
	projects: ProjectDTO[];
	selectedProjectId: string | null;
	onSelectProject: (id: string) => void;
	onAddProject: () => void;
	/** The selected project's tasks (loop-owned ones are listed under Loops). */
	tasks: TaskDTO[];
	loops: LoopDTO[];
	loading: boolean;
	onOpenTask: (task: TaskDTO) => void;
	onOpenLoops: () => void;
	onNewLoop: () => void;
}) {
	const [sort, setSort] = useState<TaskSort>("status");
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
		<ScrollView style={styles.root} contentContainerStyle={styles.content}>
			<View style={styles.column}>
				<View style={styles.sectionHead}>
					<Pressable style={styles.sectionToggle} onPress={() => setProjectsOpen((o) => !o)}>
						<Feather
							name={projectsOpen ? "chevron-down" : "chevron-right"}
							size={14}
							color={C.muted}
						/>
						<Text style={styles.sectionTitle}>Projects</Text>
					</Pressable>
					<Pressable style={styles.sortBtn} onPress={onAddProject} hitSlop={6}>
						<Feather name="folder-plus" size={16} color={C.muted} />
					</Pressable>
				</View>
				{projectsOpen &&
					(projects.length === 0 ? (
						<Text style={styles.emptyText}>No projects on this box</Text>
					) : (
						projects.map((p) => {
							const active = p.id === selectedProjectId;
							return (
								<Pressable
									key={p.id}
									style={[styles.row, active && styles.rowActive]}
									onPress={() => onSelectProject(p.id)}
								>
									<View style={styles.icon}>
										<View style={[styles.projDot, active && styles.projDotActive]} />
									</View>
									<Text style={[styles.name, active && styles.nameActive]} numberOfLines={1}>
										{p.name}
									</Text>
								</Pressable>
							);
						})
					))}

				<View style={[styles.sectionHead, styles.sectionHeadLower]}>
					<Pressable style={styles.sectionToggle} onPress={() => setTasksOpen((o) => !o)}>
						<Feather
							name={tasksOpen ? "chevron-down" : "chevron-right"}
							size={14}
							color={C.muted}
						/>
						<Text style={styles.sectionTitle}>Tasks</Text>
					</Pressable>
					<Pressable
						style={styles.sortBtn}
						onPress={() => setSort((s) => (s === "status" ? "updated" : "status"))}
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
						ordered.map((t) => <TaskRow key={t.id} task={t} onPress={() => onOpenTask(t)} />)
					))}

				<View style={[styles.sectionHead, styles.sectionHeadLower]}>
					<Pressable style={styles.sectionToggle} onPress={() => setLoopsOpen((o) => !o)}>
						<Feather
							name={loopsOpen ? "chevron-down" : "chevron-right"}
							size={14}
							color={C.muted}
						/>
						<Text style={styles.sectionTitle}>Loops</Text>
					</Pressable>
					<Pressable style={styles.sortBtn} onPress={onNewLoop} hitSlop={6}>
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
									task={task}
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
	rowActive: { backgroundColor: C.surface },
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
	empty: { paddingVertical: 20, alignItems: "center" },
	emptyText: { color: C.faint, fontSize: 13, paddingHorizontal: 14, paddingVertical: 10 },
});
