// Bottom composer on the board — mobile counterpart to the desktop
// NewTaskComposer. Type a prompt, pick the agent + launch mode, send: it creates
// a task (worktree on the box) and launches the agent, then opens its terminal.
// Auto mode = permission-free (yolo); Agent mode = the tool's own multi-agent
// board (`claude agents`) in that worktree. Attachments are a fast-follow
// (cross-machine: the phone has no files the remote agent can read).

import type { AgentDTO } from "@ateam/protocol";
import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { AgentIcon } from "./AgentIcon";
import { useKeyboardVisible } from "./useKeyboardVisible";

const C = {
	surface: "#141418",
	sunken: "#1c1c22",
	line: "#2a2a33",
	ink: "#e6e6ea",
	muted: "#9a9aa6",
	faint: "#6a6a75",
	accent: "#7c5cff",
	amber: "#fbbf24",
};

export interface ComposerSubmit {
	/** The agent's first instruction (normal mode). Empty in agent mode. */
	prompt: string;
	/** Explicit task/worktree name — set in agent mode, where there's no prompt to derive one from. */
	name?: string;
	agentId: string;
	yolo: boolean;
	agentMode: boolean;
}

export function Composer({
	agents,
	busy,
	onSubmit,
}: {
	agents: AgentDTO[];
	busy: boolean;
	onSubmit: (input: ComposerSubmit) => void;
}) {
	// Prefer an installed agent; fall back to claude so the picker is never empty
	// even when the box's availability probe came back empty (non-login daemon).
	const pickable = agents.length
		? agents
		: [{ id: "claude", label: "Claude Code", available: true } as AgentDTO];
	// One field, two roles: the agent's first instruction (normal), or the task
	// name (agent mode, which drives its own interactive board with no prompt).
	const [text, setText] = useState("");
	const [agentId, setAgentId] = useState(
		pickable.find((a) => a.available)?.id ?? pickable[0]?.id ?? "claude",
	);
	const [yolo, setYolo] = useState(false);
	const [agentMode, setAgentMode] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);
	const current = pickable.find((a) => a.id === agentId) ?? pickable[0];
	const keyboardUp = useKeyboardVisible();

	// Always need something: a prompt (normal) or a task name (agent mode).
	const canSubmit = !busy && text.trim().length > 0;

	const submit = () => {
		if (!canSubmit) return;
		const value = text.trim();
		onSubmit(
			agentMode
				? { prompt: "", name: value, agentId, yolo, agentMode: true }
				: { prompt: value, agentId, yolo, agentMode: false },
		);
		setText("");
	};

	return (
		<View style={[styles.wrap, keyboardUp && styles.wrapKeyboard]}>
			{/* Agent mode passes no prompt — but we still need to name the worktree, so
			    the field becomes an explicit task-name input (clearly labelled). */}
			{agentMode ? <Text style={styles.fieldLabel}>TASK NAME</Text> : null}
			<TextInput
				style={styles.input}
				placeholder={agentMode ? "Name this task (its worktree branch)" : "What do you want to do?"}
				placeholderTextColor={C.faint}
				value={text}
				onChangeText={setText}
				multiline={!agentMode}
				editable={!busy}
			/>
			<View style={styles.row}>
				{/* Agent picker: show only the current agent; tap to open the popover. */}
				<Pressable style={styles.chip} onPress={() => setPickerOpen(true)} hitSlop={4}>
					<AgentIcon agentId={current?.id} size={14} />
					<Text style={styles.chipTextOn}>{current?.label.replace(/ Code$/, "") ?? "Agent"}</Text>
					{pickable.length > 1 ? <Text style={styles.caret}>▾</Text> : null}
				</Pressable>
				<Modal
					visible={pickerOpen}
					transparent
					animationType="fade"
					onRequestClose={() => setPickerOpen(false)}
				>
					<Pressable style={styles.backdrop} onPress={() => setPickerOpen(false)}>
						<View style={styles.popover}>
							{pickable.map((a) => (
								<Pressable
									key={a.id}
									style={styles.popRow}
									onPress={() => {
										setAgentId(a.id);
										setPickerOpen(false);
									}}
								>
									<AgentIcon agentId={a.id} size={16} />
									<Text style={styles.popText}>{a.label}</Text>
									{a.id === agentId ? <Text style={styles.popCheck}>✓</Text> : null}
								</Pressable>
							))}
						</View>
					</Pressable>
				</Modal>
				<View style={styles.spacer} />
				{/* Auto mode (yolo) */}
				<Pressable
					style={[styles.mode, yolo && styles.modeAuto]}
					onPress={() => setYolo((v) => !v)}
					hitSlop={4}
				>
					<Text style={[styles.modeText, yolo && { color: C.amber }]}>auto</Text>
				</Pressable>
				{/* Agent mode (claude agents) */}
				<Pressable
					style={[styles.mode, agentMode && styles.modeAgents]}
					onPress={() => setAgentMode((v) => !v)}
					hitSlop={4}
				>
					<Text style={[styles.modeText, agentMode && { color: C.accent }]}>agents</Text>
				</Pressable>
				{/* Send */}
				<Pressable
					style={[styles.send, !canSubmit && styles.sendOff]}
					onPress={submit}
					disabled={!canSubmit}
					hitSlop={6}
				>
					<Text style={styles.sendText}>↑</Text>
				</Pressable>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	wrap: {
		borderTopWidth: 1,
		borderTopColor: C.line,
		backgroundColor: C.surface,
		paddingHorizontal: 12,
		paddingTop: 10,
		// Extra bottom padding clears the iOS home indicator so the mode buttons
		// aren't hidden behind it — but drop it when the keyboard is up (it already
		// covers that area).
		paddingBottom: 42,
		gap: 8,
	},
	wrapKeyboard: { paddingBottom: 10 },
	// agent popover
	backdrop: {
		flex: 1,
		backgroundColor: "rgba(0,0,0,0.5)",
		justifyContent: "flex-end",
		padding: 16,
		paddingBottom: 90,
	},
	popover: {
		backgroundColor: C.surface,
		borderWidth: 1,
		borderColor: C.line,
		borderRadius: 12,
		paddingVertical: 6,
	},
	popRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingHorizontal: 14,
		paddingVertical: 12,
	},
	popText: { color: C.ink, fontSize: 15, flex: 1 },
	popCheck: { color: C.ink, fontSize: 15, fontWeight: "700" },
	caret: { color: C.muted, fontSize: 10, marginLeft: 2 },
	input: {
		color: C.ink,
		fontSize: 15,
		backgroundColor: C.sunken,
		borderWidth: 1,
		borderColor: C.line,
		borderRadius: 10,
		paddingHorizontal: 12,
		paddingVertical: 10,
		minHeight: 40,
		maxHeight: 120,
	},
	fieldLabel: {
		color: C.accent,
		fontSize: 10,
		fontWeight: "700",
		letterSpacing: 1.1,
		paddingLeft: 2,
		marginBottom: -2,
	},
	row: { flexDirection: "row", alignItems: "center", gap: 6 },
	spacer: { flex: 1 },
	chip: {
		flexDirection: "row",
		gap: 5,
		paddingHorizontal: 10,
		height: 30,
		borderRadius: 8,
		backgroundColor: C.sunken,
		borderWidth: 1,
		borderColor: C.line,
		alignItems: "center",
		justifyContent: "center",
	},
	chipOn: { borderColor: C.accent, backgroundColor: "rgba(124,92,255,0.16)" },
	chipText: { color: C.muted, fontSize: 12, fontWeight: "600" },
	chipTextOn: { color: C.ink },
	mode: {
		paddingHorizontal: 10,
		height: 30,
		borderRadius: 8,
		backgroundColor: C.sunken,
		borderWidth: 1,
		borderColor: C.line,
		alignItems: "center",
		justifyContent: "center",
	},
	modeAuto: { borderColor: C.amber, backgroundColor: "rgba(251,191,36,0.13)" },
	modeAgents: { borderColor: C.accent, backgroundColor: "rgba(124,92,255,0.16)" },
	modeText: { color: C.muted, fontSize: 12, fontWeight: "600" },
	send: {
		width: 34,
		height: 34,
		borderRadius: 8,
		backgroundColor: C.ink,
		alignItems: "center",
		justifyContent: "center",
	},
	sendOff: { opacity: 0.35 },
	sendText: { color: "#15151a", fontSize: 18, fontWeight: "800" },
});
