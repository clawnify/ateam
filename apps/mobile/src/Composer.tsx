// Bottom composer on the board — mobile counterpart to the desktop
// NewTaskComposer. Type a prompt, pick the agent + launch mode, send: it creates
// a task (worktree on the box) and launches the agent, then opens its terminal.
// Long-press send to start it and stay on the board instead (a snackbar above
// the composer then offers the way in).
// Auto mode = permission-free (yolo); Agent mode = the tool's own multi-agent
// board (`claude agents`) in that worktree. Attachments are a fast-follow
// (cross-machine: the phone has no files the remote agent can read).

import type { AgentDTO } from "@ateam/protocol";
import { useEffect, useRef, useState } from "react";
import {
	ActionSheetIOS,
	Alert,
	findNodeHandle,
	Modal,
	Platform,
	Pressable,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { AgentIcon } from "./AgentIcon";
import { useKeyboardVisible } from "./useKeyboardVisible";

const C = {
	surface: "#141418",
	sunken: "#1c1c22",
	line: "#2a2a33",
	ink: "#e6e6ea",
	muted: "#9a9aa6",
	faint: "#6a6a75",
	amber: "#fbbf24",
};

// Match App's CONTENT_MAX: center + cap the composer content on iPad (no-op on iPhone).
const CONTENT_MAX = 720;

export interface ComposerSubmit {
	/** The agent's first instruction (normal mode). Empty in agent mode. */
	prompt: string;
	/** Explicit task/worktree name — set in agent mode, where there's no prompt to derive one from. */
	name?: string;
	agentId: string;
	yolo: boolean;
	agentMode: boolean;
	/** false: start it in the background and stay on the board (long-press send). */
	open: boolean;
}

export function Composer({
	agents,
	busy,
	onSubmit,
	started,
	onOpenStarted,
	onDismissStarted,
}: {
	agents: AgentDTO[];
	busy: boolean;
	onSubmit: (input: ComposerSubmit) => void;
	/** Name of the task just started in the background, shown in the snackbar. */
	started: string | null;
	onOpenStarted: () => void;
	onDismissStarted: () => void;
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
	// The agent list arrives after the first render, and it is per-BOX: the
	// default picked above can turn out to be one this box hasn't got. Drop to
	// the first it can actually run (the desktop composer does the same when you
	// switch environment). If it has none, leave the pick alone and let the
	// launch say so.
	useEffect(() => {
		if (!agents.length || agents.some((a) => a.id === agentId && a.available)) return;
		const first = agents.find((a) => a.available);
		if (first) setAgentId(first.id);
	}, [agents, agentId]);
	const current = pickable.find((a) => a.id === agentId) ?? pickable[0];
	const keyboardUp = useKeyboardVisible();

	// Always need something: a prompt (normal) or a task name (agent mode).
	const canSubmit = !busy && text.trim().length > 0;

	const submit = (open: boolean) => {
		if (!canSubmit) return;
		const value = text.trim();
		onSubmit(
			agentMode
				? { prompt: "", name: value, agentId, yolo, agentMode: true, open }
				: { prompt: value, agentId, yolo, agentMode: false, open },
		);
		setText("");
	};

	// Long-press send: choose between opening the new task and staying here. A tap
	// still opens it, as it always has.
	const sendRef = useRef<View>(null);
	const chooseLanding = () => {
		if (!canSubmit) return;
		const options = ["Start and open", "Start, stay on board"];
		if (Platform.OS === "ios") {
			const anchor = sendRef.current ? findNodeHandle(sendRef.current) : null;
			ActionSheetIOS.showActionSheetWithOptions(
				// iPad shows the sheet as a popover, pointing at the send button.
				{ options: [...options, "Cancel"], cancelButtonIndex: 2, anchor: anchor ?? undefined },
				(i) => {
					if (i === 0) submit(true);
					if (i === 1) submit(false);
				},
			);
			return;
		}
		Alert.alert("Start task", undefined, [
			{ text: options[0], onPress: () => submit(true) },
			{ text: options[1], onPress: () => submit(false) },
			{ text: "Cancel", style: "cancel" },
		]);
	};

	return (
		<View style={[styles.wrap, keyboardUp && styles.wrapKeyboard]}>
			{started ? (
				<View style={styles.snack} accessibilityLiveRegion="polite">
					<Pressable style={styles.snackMain} onPress={onDismissStarted}>
						<Text style={styles.snackText} numberOfLines={1}>
							Started {started}
						</Text>
					</Pressable>
					<Pressable onPress={onOpenStarted} hitSlop={10} accessibilityRole="button">
						<Text style={styles.snackAction}>Open</Text>
					</Pressable>
				</View>
			) : null}
			<View style={styles.inner}>
				{/* Agent mode passes no prompt — but we still need to name the worktree, so
			    the field becomes an explicit task-name input (clearly labelled). */}
				{agentMode ? <Text style={styles.fieldLabel}>TASK NAME</Text> : null}
				<TextInput
					style={styles.input}
					placeholder={agentMode ? "Name this task" : "What do you want to do?"}
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
										disabled={!a.available}
										onPress={() => {
											setAgentId(a.id);
											setPickerOpen(false);
										}}
									>
										<AgentIcon agentId={a.id} size={16} />
										<View style={styles.popTextWrap}>
											<Text style={[styles.popText, !a.available && styles.popTextOff]}>
												{a.label}
											</Text>
											{/* Listed but unpickable, rather than hidden: the box either has
											    this agent or can be given it, and a row that quietly vanishes
											    reads as "Ateam dropped support" instead of "install it here". */}
											{!a.available ? (
												<Text style={styles.popSub}>not installed on this box</Text>
											) : null}
										</View>
										{a.id === agentId && a.available ? (
											<Text style={styles.popCheck}>✓</Text>
										) : null}
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
						<Text style={[styles.modeText, agentMode && { color: C.ink }]}>agents</Text>
					</Pressable>
					{/* Send */}
					<Pressable
						ref={sendRef}
						style={[styles.send, !canSubmit && styles.sendOff]}
						onPress={() => submit(true)}
						onLongPress={chooseLanding}
						disabled={!canSubmit}
						hitSlop={6}
						accessibilityRole="button"
						accessibilityLabel="Start task"
						accessibilityHint="Opens the new task. Long press to start it and stay on the board."
					>
						<Text style={styles.sendText}>↑</Text>
					</Pressable>
				</View>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	inner: { width: "100%", maxWidth: CONTENT_MAX, alignSelf: "center" },
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
	popTextWrap: { flex: 1 },
	popText: { color: C.ink, fontSize: 15 },
	popTextOff: { color: C.faint },
	popSub: { color: C.faint, fontSize: 11, marginTop: 2 },
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
		color: C.ink,
		fontSize: 10,
		fontWeight: "700",
		letterSpacing: 1.1,
		paddingLeft: 2,
		marginBottom: -2,
	},
	// Breathing room between the prompt field and the controls under it.
	row: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 },
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
	chipOn: { borderColor: C.ink, backgroundColor: "rgba(230,230,234,0.12)" },
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
	modeAgents: { borderColor: C.ink, backgroundColor: "rgba(230,230,234,0.12)" },
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
	// Floats just above the composer, over the bottom of the board.
	snack: {
		position: "absolute",
		bottom: "100%",
		left: 12,
		right: 12,
		marginBottom: 8,
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		backgroundColor: C.sunken,
		borderWidth: 1,
		borderColor: C.line,
		borderRadius: 10,
		paddingHorizontal: 14,
		paddingVertical: 11,
	},
	snackMain: { flex: 1 },
	snackText: { color: C.ink, fontSize: 14 },
	snackAction: { color: C.ink, fontSize: 14, fontWeight: "700" },
	sendText: { color: "#15151a", fontSize: 18, fontWeight: "800" },
});
