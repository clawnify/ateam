// Bottom composer on the board — mobile counterpart to the desktop
// NewTaskComposer. Type a prompt, pick the agent + launch mode, send: it creates
// a task (worktree on the box) and launches the agent, then opens its terminal.
// Auto mode = permission-free (yolo); Agent mode = the tool's own multi-agent
// board (`claude agents`) in that worktree. Attachments are a fast-follow
// (cross-machine: the phone has no files the remote agent can read).

import type { AgentDTO } from "@ateam/protocol";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

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
	prompt: string;
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
	const [prompt, setPrompt] = useState("");
	const [agentId, setAgentId] = useState(
		pickable.find((a) => a.available)?.id ?? pickable[0]?.id ?? "claude",
	);
	const [yolo, setYolo] = useState(false);
	const [agentMode, setAgentMode] = useState(false);

	// Agent mode takes the task interactively on its own board, so a prompt is
	// optional there; otherwise a prompt (or at least something) is required.
	const canSubmit = !busy && (agentMode || prompt.trim().length > 0);

	const submit = () => {
		if (!canSubmit) return;
		onSubmit({ prompt: prompt.trim(), agentId, yolo, agentMode });
		setPrompt("");
	};

	return (
		<View style={styles.wrap}>
			<TextInput
				style={styles.input}
				placeholder={
					agentMode ? "Describe the task (optional in agent mode)…" : "What do you want to do?"
				}
				placeholderTextColor={C.faint}
				value={prompt}
				onChangeText={setPrompt}
				multiline
				editable={!busy}
			/>
			<View style={styles.row}>
				{/* Agent picker — tappable chips (few agents, no dropdown needed). */}
				{pickable.map((a) => (
					<Pressable
						key={a.id}
						style={[styles.chip, agentId === a.id && styles.chipOn]}
						onPress={() => setAgentId(a.id)}
						hitSlop={4}
					>
						<Text style={[styles.chipText, agentId === a.id && styles.chipTextOn]}>
							{a.label.replace(/ Code$/, "")}
						</Text>
					</Pressable>
				))}
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
		paddingBottom: 12,
		gap: 8,
	},
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
	row: { flexDirection: "row", alignItems: "center", gap: 6 },
	spacer: { flex: 1 },
	chip: {
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
