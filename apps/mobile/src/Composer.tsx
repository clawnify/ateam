// Bottom composer on the board — mobile counterpart to the desktop
// NewTaskComposer. Type a prompt, pick the agent + launch mode, send: it creates
// a task (worktree on the box) and launches the agent, then opens its terminal.
// Or, with the switch floating above it on Lead, the text goes to the box's
// Lead chat instead, and the chat opens to show the answer; the row then holds
// the Lead's own controls. The switch remembers the last choice; a box without
// its own Lead (before v24) shows no switch.
// Long-press send to start it and stay on the board instead (a snackbar above
// the composer then offers the way in).
// Auto mode = the agent's automatic mode (yolo); Agent mode = the tool's own multi-agent
// board (`claude agents`) in that worktree. The paperclip attaches photos or
// files, held here and uploaded on send to where the message goes (attach.tsx).

import type { AgentDTO, LeadClient } from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import { useEffect, useRef, useState } from "react";
import {
	ActionSheetIOS,
	Alert,
	Animated,
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
import {
	AttachmentStrip,
	chooseAttachments,
	filesToLead,
	type PickedFile,
	useLeadAuto,
} from "./attach";
import { type ComposerTarget, loadComposerTarget, saveComposerTarget } from "./storage";
import { useKeyboardVisible } from "./useKeyboardVisible";

// The last choice, read once from storage and then kept here, so a composer
// that remounts (a tab switch) starts on it with no flicker.
let lastTarget: ComposerTarget | null = null;

const C = {
	surface: "#141418",
	sunken: "#1c1c22",
	line: "#2a2a33",
	ink: "#e6e6ea",
	muted: "#9a9aa6",
	faint: "#6a6a75",
	amber: "#fbbf24",
};

const INK_ON_WHITE = "#15151a";

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
	/** Attached on this phone; the caller puts them on the box for the agent. */
	files: PickedFile[];
}

/** The floating switch's band, laid over the bottom of the content above. */
const FLOAT = 48;

export function Composer({
	agents,
	busy,
	onSubmit,
	lead,
	onLeadSent,
	switchFaded = false,
	snack,
	onOpenSnack,
	onDismissSnack,
}: {
	agents: AgentDTO[];
	busy: boolean;
	onSubmit: (input: ComposerSubmit) => void;
	/** The box's own Lead. Absent when it has none: no switch, it starts tasks. */
	lead?: LeadClient;
	/** A message went to the Lead (`open`: show the chat). */
	onLeadSent?: (open: boolean) => void;
	/** The list under the floating switch is scrolling: it fades out of the way. */
	switchFaded?: boolean;
	/** What was just done in the background ("Started …", "Sent to the Lead"). */
	snack: string | null;
	onOpenSnack: () => void;
	onDismissSnack: () => void;
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
	const [target, setTargetState] = useState<ComposerTarget>(lastTarget ?? "task");
	useEffect(() => {
		if (lastTarget) return;
		void loadComposerTarget().then((t) => {
			lastTarget = t;
			setTargetState(t);
		});
	}, []);
	const setTarget = (t: ComposerTarget) => {
		lastTarget = t;
		setTargetState(t);
		void saveComposerTarget(t);
	};
	const toLead = target === "lead" && lead !== undefined;
	const switchOpacity = useRef(new Animated.Value(1)).current;
	useEffect(() => {
		Animated.timing(switchOpacity, {
			toValue: switchFaded ? 0 : 1,
			duration: switchFaded ? 120 : 200,
			useNativeDriver: true,
		}).start();
	}, [switchFaded, switchOpacity]);
	const [leadAuto, toggleLeadAuto] = useLeadAuto(lead, toLead);
	const [files, setFiles] = useState<PickedFile[]>([]);
	const [note, setNote] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	// Agent mode starts the tool's own board with no prompt to hang files on.
	const canAttach = toLead || !agentMode;

	// Always need something: a prompt (normal) or a task name (agent mode). The
	// Lead also takes files alone.
	const canSubmit = toLead
		? !sending && (text.trim().length > 0 || files.length > 0)
		: !busy && text.trim().length > 0;

	const attach = async () => {
		const picked = await chooseAttachments();
		if (picked.files.length) setFiles((cur) => [...cur, ...picked.files]);
		setNote(picked.note);
	};

	const submit = async (open: boolean) => {
		if (!canSubmit) return;
		const value = text.trim();
		setNote(null);
		if (toLead && lead) {
			setSending(true);
			try {
				await lead.send(value, await filesToLead(lead, files));
				setText("");
				setFiles([]);
				onLeadSent?.(open);
			} catch (e) {
				setNote(e instanceof Error ? e.message : String(e));
			} finally {
				setSending(false);
			}
			return;
		}
		const sent = agentMode ? [] : files;
		onSubmit(
			agentMode
				? { prompt: "", name: value, agentId, yolo, agentMode: true, open, files: sent }
				: { prompt: value, agentId, yolo, agentMode: false, open, files: sent },
		);
		setText("");
		setFiles([]);
	};

	// Long-press send: choose between opening the new task and staying here. A tap
	// still opens it, as it always has.
	const sendRef = useRef<View>(null);
	const chooseLanding = () => {
		if (!canSubmit) return;
		const options = toLead
			? ["Send and open the Lead", "Send, stay here"]
			: ["Start and open", "Start, stay on board"];
		if (Platform.OS === "ios") {
			const anchor = sendRef.current ? findNodeHandle(sendRef.current) : null;
			ActionSheetIOS.showActionSheetWithOptions(
				// iPad shows the sheet as a popover, pointing at the send button.
				{ options: [...options, "Cancel"], cancelButtonIndex: 2, anchor: anchor ?? undefined },
				(i) => {
					if (i === 0) void submit(true);
					if (i === 1) void submit(false);
				},
			);
			return;
		}
		Alert.alert(toLead ? "Ask the Lead" : "Start task", undefined, [
			{ text: options[0], onPress: () => void submit(true) },
			{ text: options[1], onPress: () => void submit(false) },
			{ text: "Cancel", style: "cancel" },
		]);
	};

	return (
		// With the switch, the composer reaches FLOAT up over the content above,
		// where the switch floats centred; only the switch and the panel take touches.
		<View pointerEvents="box-none" style={lead ? styles.floatRoot : undefined}>
			{lead ? (
				<Animated.View
					pointerEvents={switchFaded ? "none" : "box-none"}
					style={[styles.floatBand, { opacity: switchOpacity }]}
				>
					<View style={styles.switch} accessibilityRole="tablist">
						{(["task", "lead"] as const).map((t) => {
							const on = (t === "lead") === toLead;
							return (
								<Pressable
									key={t}
									style={[styles.switchSeg, on && styles.switchSegOn]}
									onPress={() => setTarget(t)}
									hitSlop={4}
									accessibilityRole="tab"
									accessibilityState={{ selected: on }}
								>
									<Feather
										name={t === "lead" ? "message-circle" : "plus-square"}
										size={13}
										color={on ? INK_ON_WHITE : C.muted}
									/>
									<Text style={[styles.switchText, on && styles.switchTextOn]}>
										{t === "lead" ? "Lead" : "Task"}
									</Text>
								</Pressable>
							);
						})}
					</View>
				</Animated.View>
			) : null}
			<View style={[styles.wrap, keyboardUp && styles.wrapKeyboard]}>
				{snack ? (
					<View style={styles.snack} accessibilityLiveRegion="polite">
						<Pressable style={styles.snackMain} onPress={onDismissSnack}>
							<Text style={styles.snackText} numberOfLines={1}>
								{snack}
							</Text>
						</Pressable>
						<Pressable onPress={onOpenSnack} hitSlop={10} accessibilityRole="button">
							<Text style={styles.snackAction}>Open</Text>
						</Pressable>
					</View>
				) : null}
				<View style={styles.inner}>
					{note ? <Text style={styles.note}>{note}</Text> : null}
					<AttachmentStrip
						style={styles.strip}
						files={files}
						onRemove={(f) => setFiles((cur) => cur.filter((x) => x !== f))}
					/>
					{/* Agent mode passes no prompt — but we still need to name the worktree, so
			    the field becomes an explicit task-name input (clearly labelled). */}
					{agentMode && !toLead ? <Text style={styles.fieldLabel}>TASK NAME</Text> : null}
					<TextInput
						style={styles.input}
						placeholder={
							toLead ? "Ask the Lead" : agentMode ? "Name this task" : "What do you want to do?"
						}
						placeholderTextColor={C.faint}
						value={text}
						onChangeText={setText}
						multiline={toLead || !agentMode}
						editable={toLead || !busy}
					/>
					<View style={styles.row}>
						<Pressable
							style={[styles.iconBtn, !canAttach && styles.sendOff]}
							onPress={() => void attach()}
							disabled={!canAttach}
							hitSlop={4}
							accessibilityRole="button"
							accessibilityLabel="Attach photos or files"
						>
							<Feather name="paperclip" size={16} color={C.muted} />
						</Pressable>
						{toLead && (
							// The Lead's own ⚡: Claude's auto mode for the box's Lead, kept
							// across conversations (the chat has the same switch).
							<Pressable
								style={styles.iconBtn}
								onPress={toggleLeadAuto}
								hitSlop={4}
								accessibilityRole="switch"
								accessibilityLabel="Lead auto mode"
								accessibilityState={{ checked: leadAuto }}
							>
								<Feather name="zap" size={16} color={leadAuto ? C.amber : C.muted} />
							</Pressable>
						)}
						{/* The agent and how it starts are a task's. */}
						{!toLead && (
							<>
								{/* Agent picker: show only the current agent; tap to open the popover. */}
								<Pressable style={styles.chip} onPress={() => setPickerOpen(true)} hitSlop={4}>
									<AgentIcon agentId={current?.id} size={14} />
									<Text style={styles.chipTextOn}>
										{current?.label.replace(/ Code$/, "") ?? "Agent"}
									</Text>
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
							</>
						)}
						{toLead && <View style={styles.spacer} />}
						{/* Send */}
						<Pressable
							ref={sendRef}
							style={[styles.send, !canSubmit && styles.sendOff]}
							onPress={() => void submit(true)}
							onLongPress={chooseLanding}
							disabled={!canSubmit}
							hitSlop={6}
							accessibilityRole="button"
							accessibilityLabel={toLead ? "Ask the Lead" : "Start task"}
							accessibilityHint={
								toLead
									? "Opens the Lead chat. Long press to send and stay here."
									: "Opens the new task. Long press to start it and stay on the board."
							}
						>
							<Text style={styles.sendText}>↑</Text>
						</Pressable>
					</View>
				</View>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	inner: { width: "100%", maxWidth: CONTENT_MAX, alignSelf: "center" },
	floatRoot: { marginTop: -FLOAT },
	floatBand: { height: FLOAT, alignItems: "center", justifyContent: "center" },
	// Task | Lead: the header's tab pill, small, floating over the content.
	switch: {
		flexDirection: "row",
		backgroundColor: C.sunken,
		borderRadius: 999,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: C.line,
		padding: 3,
		gap: 2,
		shadowColor: "#000",
		shadowOpacity: 0.45,
		shadowRadius: 12,
		shadowOffset: { width: 0, height: 4 },
	},
	strip: { marginBottom: 8 },
	iconBtn: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
	note: { color: "#f87171", fontSize: 12.5, marginBottom: 6 },
	switchSeg: {
		flexDirection: "row",
		alignItems: "center",
		gap: 5,
		paddingHorizontal: 11,
		paddingVertical: 5,
		borderRadius: 999,
	},
	switchSegOn: { backgroundColor: C.ink },
	switchText: { color: C.muted, fontSize: 12.5, fontWeight: "600" },
	switchTextOn: { color: INK_ON_WHITE },
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
