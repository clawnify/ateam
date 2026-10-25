// The thin bar above a terminal: agent icon, task name, status dot, and the
// expand / collapse toggle. Mission Control tiles and the full-width view share
// it, so a terminal reads the same in both places. The full view swaps the icon
// for the agent / Shell switch (the desktop's tabs); the box terminal uses StripBar.
import type { TaskDTO } from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { AgentIcon } from "./AgentIcon";
import { statusColor } from "./HomeScreen";
import { C } from "./theme";

export function TerminalStrip({
	task,
	expanded,
	onToggle,
	shell = false,
	onShell,
}: {
	task: TaskDTO;
	/** Full-width view shows a collapse icon; a tile shows expand. */
	expanded: boolean;
	onToggle: () => void;
	/** Whether the worktree's shell is showing instead of the agent. */
	shell?: boolean;
	/** Switch between the agent and the shell. Tiles, and tasks with no agent, leave it out. */
	onShell?: (shell: boolean) => void;
}) {
	return (
		<StripBar
			lead={
				onShell ? (
					<View style={styles.tabs}>
						<Pressable
							style={[styles.tab, !shell && styles.tabOn]}
							onPress={() => onShell(false)}
							hitSlop={{ top: 4, bottom: 4 }}
							accessibilityRole="button"
							accessibilityLabel="Agent"
							accessibilityState={{ selected: !shell }}
						>
							<AgentIcon agentId={task.agentId} size={12} />
						</Pressable>
						<Pressable
							style={[styles.tab, shell && styles.tabOn]}
							onPress={() => onShell(true)}
							hitSlop={{ top: 4, bottom: 4 }}
							accessibilityRole="button"
							accessibilityLabel="Shell"
							accessibilityState={{ selected: shell }}
						>
							<Feather name="terminal" size={12} color={shell ? C.ink : C.muted} />
							<Text style={[styles.tabText, shell && styles.tabTextOn]}>Shell</Text>
						</Pressable>
					</View>
				) : (
					<AgentIcon agentId={task.agentId} size={12} />
				)
			}
			title={task.name}
			dotColor={statusColor(task)}
			expanded={expanded}
			onToggle={onToggle}
		/>
	);
}

/** The bar itself. The box terminal, which belongs to no task, uses it directly. */
export function StripBar({
	lead,
	title,
	dotColor,
	expanded,
	onToggle,
}: {
	lead: ReactNode;
	title: string;
	dotColor?: string;
	expanded: boolean;
	onToggle: () => void;
}) {
	return (
		// Not one accessibility element, so VoiceOver can reach the controls inside.
		<Pressable style={styles.strip} onPress={onToggle} accessible={false}>
			{lead}
			<Text style={styles.name} numberOfLines={1}>
				{title}
			</Text>
			{dotColor ? <View style={[styles.dot, { backgroundColor: dotColor }]} /> : null}
			<Pressable
				style={styles.toggle}
				onPress={onToggle}
				hitSlop={8}
				accessibilityRole="button"
				accessibilityLabel={expanded ? "Back to board" : "Expand"}
			>
				<Feather name={expanded ? "minimize-2" : "maximize-2"} size={13} color={C.muted} />
			</Pressable>
		</Pressable>
	);
}

const styles = StyleSheet.create({
	strip: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		paddingHorizontal: 12,
		height: 30,
		backgroundColor: C.surface,
		borderTopWidth: 1,
		borderTopColor: C.line,
		borderBottomWidth: 1,
		borderBottomColor: C.line,
	},
	name: { flex: 1, color: C.ink, fontSize: 12, fontWeight: "600" },
	dot: { width: 6, height: 6, borderRadius: 3 },
	toggle: { marginLeft: 8 },
	tabs: {
		flexDirection: "row",
		borderWidth: 1,
		borderColor: C.line,
		borderRadius: 6,
		overflow: "hidden",
	},
	tab: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, height: 22 },
	tabOn: { backgroundColor: C.line },
	tabText: { color: C.muted, fontSize: 11, fontWeight: "600" },
	tabTextOn: { color: C.ink },
});
