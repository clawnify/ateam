import {
	type AgentEffort,
	type AteamApi,
	type Effort,
	EFFORT_LEVELS,
	effortLabel,
	resolveEffort,
} from "@ateam/protocol";
import { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { C } from "./theme";

export function EffortPicker({
	api,
	projectId,
	agentId,
	loopId,
	value,
	onChange,
	compact = false,
}: {
	api: AteamApi;
	projectId?: string | null;
	agentId: string;
	loopId?: string;
	value: Effort | null;
	onChange: (value: Effort | null) => void;
	compact?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const key = JSON.stringify([projectId, agentId, loopId]);
	const [loaded, setLoaded] = useState<{ key: string; data: AgentEffort | null }>();
	useEffect(() => {
		if (!projectId) return;
		let current = true;
		void api.agents.effort({ projectId, agentId, loopId }).then(
			(data) => {
				if (current) setLoaded({ key, data });
			},
			() => {
				if (current) setLoaded({ key, data: null });
			},
		);
		return () => {
			current = false;
		};
	}, [api, key, projectId, agentId, loopId]);

	const data = loaded?.key === key ? loaded.data : null;
	const levels = data?.levels ?? [];
	if (!levels.length && !value) return null;
	const applied = value ? resolveEffort(value, levels) : null;
	const options = [
		null,
		...EFFORT_LEVELS.filter((level) => level === value || levels.includes(level)),
	];
	const close = () => setOpen(false);
	return (
		<>
			<Pressable
				style={styles.chip}
				onPress={() => setOpen(true)}
				hitSlop={4}
				accessibilityRole="button"
				accessibilityLabel={`Effort, ${effortLabel(value)}`}
			>
				<Text style={styles.chipText}>
					{compact ? (value ? effortLabel(value) : "Effort") : `Effort · ${effortLabel(value)}`} ▾
				</Text>
			</Pressable>
			<Modal visible={open} transparent animationType="fade" onRequestClose={close}>
				<View style={styles.backdrop}>
					<Pressable
						style={StyleSheet.absoluteFill}
						onPress={close}
						accessibilityLabel="Close effort picker"
					/>
					<View style={styles.menu}>
						<Text style={styles.heading}>{data ? `Effort · ${data.model}` : "Effort"}</Text>
						{options.map((level) => (
							<Pressable
								key={level ?? "default"}
								style={styles.row}
								accessibilityRole="radio"
								accessibilityState={{ selected: level === value }}
								onPress={() => {
									onChange(level);
									close();
								}}
							>
								<Text style={styles.label}>
									{effortLabel(level)}
									{data && level && level === value && level !== applied
										? ` (uses ${effortLabel(applied)})`
										: ""}
								</Text>
								{level === value && <Text style={styles.label}>✓</Text>}
							</Pressable>
						))}
					</View>
				</View>
			</Modal>
		</>
	);
}

const styles = StyleSheet.create({
	chip: {
		alignSelf: "flex-start",
		borderRadius: 8,
		paddingHorizontal: 7,
		paddingVertical: 5,
		backgroundColor: C.sunken,
	},
	chipText: { color: C.ink, fontSize: 12 },
	backdrop: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#0007" },
	menu: {
		width: 250,
		backgroundColor: C.surface,
		borderColor: C.line,
		borderWidth: 1,
		borderRadius: 12,
		padding: 8,
	},
	heading: { color: C.muted, fontSize: 12, padding: 10 },
	row: {
		minHeight: 44,
		paddingHorizontal: 10,
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
	},
	label: { color: C.ink, fontSize: 14 },
});
