// The thin bar above a terminal: agent icon, task name, status dot, and the
// expand / collapse toggle. Mission Control tiles and the full-width view share
// it, so a terminal reads the same in both places.
import type { TaskDTO } from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { AgentIcon } from "./AgentIcon";
import { statusColor } from "./HomeScreen";
import { C } from "./theme";

export function TerminalStrip({
	task,
	expanded,
	onToggle,
}: {
	task: TaskDTO;
	/** Full-width view shows a collapse icon; a tile shows expand. */
	expanded: boolean;
	onToggle: () => void;
}) {
	return (
		<Pressable style={styles.strip} onPress={onToggle}>
			<AgentIcon agentId={task.agentId} size={12} />
			<Text style={styles.name} numberOfLines={1}>
				{task.name}
			</Text>
			<View style={[styles.dot, { backgroundColor: statusColor(task) }]} />
			<Feather
				name={expanded ? "minimize-2" : "maximize-2"}
				size={13}
				color={C.muted}
				style={styles.toggle}
			/>
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
});
