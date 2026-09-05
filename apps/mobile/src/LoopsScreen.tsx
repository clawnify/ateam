// Loops tab: every loop on the selected project, with the desktop's controls
// (Run now, enable/pause, edit, delete) and the same status line. Creating and
// editing goes through LoopForm, which App renders as a modal so Home's plus
// can open it too.
import type { AgentDTO, AteamApi, LoopDTO, TaskDTO } from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import { useEffect, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	KeyboardAvoidingView,
	Modal,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Switch,
	Text,
	TextInput,
	View,
} from "react-native";
import { AgentIcon } from "./AgentIcon";
import { C, CONTENT_MAX } from "./theme";

/** "in 45s" / "in 2m" / "now", or "—" when no next run is scheduled. */
function untilLabel(nextRunAt: number | null, now: number): string {
	if (nextRunAt == null) return "—";
	const ms = nextRunAt - now;
	if (ms <= 0) return "now";
	const s = Math.round(ms / 1000);
	if (s < 60) return `in ${s}s`;
	return `in ${Math.round(s / 60)}m`;
}

/** "12s ago" / "3m ago" / "never". */
function agoLabel(lastRunAt: number | null, now: number): string {
	if (lastRunAt == null) return "never";
	const s = Math.round((now - lastRunAt) / 1000);
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	return `${Math.round(s / 3600)}h ago`;
}

/** "every 5m" / "every 2h". */
function everyLabel(intervalMs: number | null): string {
	if (intervalMs == null) return "";
	const min = Math.round(intervalMs / 60_000);
	return min < 60 ? `every ${min}m` : `every ${Math.round(min / 60)}h`;
}

export function LoopsScreen({
	api,
	loops,
	tasks,
	onOpenTask,
	onCreate,
	onEdit,
	onChanged,
}: {
	api: AteamApi;
	loops: LoopDTO[];
	tasks: TaskDTO[];
	onOpenTask: (task: TaskDTO) => void;
	onCreate: () => void;
	onEdit: (loop: LoopDTO) => void;
	onChanged: (loops: LoopDTO[]) => void;
}) {
	const [busy, setBusy] = useState<string | null>(null);
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 5000);
		return () => clearInterval(t);
	}, []);

	const run = async (l: LoopDTO, op: () => Promise<LoopDTO[]>) => {
		setBusy(l.id);
		try {
			onChanged(await op());
		} catch (err) {
			Alert.alert("Loop", err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};
	const remove = (l: LoopDTO) =>
		Alert.alert("Delete loop", `Delete "${l.title}"? Its task stays on the board.`, [
			{ text: "Cancel", style: "cancel" },
			{
				text: "Delete",
				style: "destructive",
				onPress: () => void run(l, () => api.loops.remove(l.id)),
			},
		]);

	return (
		<ScrollView style={styles.root} contentContainerStyle={styles.content}>
			<View style={styles.column}>
				<View style={styles.head}>
					<Text style={styles.title}>Loops</Text>
					<Pressable style={styles.newBtn} onPress={onCreate} hitSlop={6}>
						<Feather name="plus" size={14} color="#15151a" />
						<Text style={styles.newText}>New loop</Text>
					</Pressable>
				</View>
				{loops.length === 0 && (
					<Text style={styles.empty}>No loops on this project. Create one.</Text>
				)}
				{loops.map((l) => {
					const task = l.taskId ? (tasks.find((t) => t.id === l.taskId) ?? null) : null;
					return (
						<View key={l.id} style={[styles.card, !l.enabled && styles.cardOff]}>
							<Pressable onPress={() => task && onOpenTask(task)} disabled={!task}>
								<View style={styles.cardTitleRow}>
									<AgentIcon agentId={l.agentId ?? "claude"} size={14} />
									<Text style={styles.cardTitle} numberOfLines={1}>
										{l.title}
									</Text>
									<Text style={styles.cadence}>{everyLabel(l.intervalMs)}</Text>
								</View>
								{l.prompt ? (
									<Text style={styles.prompt} numberOfLines={2}>
										{l.prompt}
									</Text>
								) : null}
								<Text style={styles.meta} numberOfLines={2}>
									{l.lastStatus === "error" ? (
										<Text style={styles.err}>{l.lastError ?? "error"}</Text>
									) : (
										<Text style={styles.ok}>{l.lastSummary ?? "not run yet"}</Text>
									)}
									{`  · ran ${agoLabel(l.lastRunAt, now)} · ${l.runs} runs`}
									{l.enabled ? ` · next ${untilLabel(l.nextRunAt, now)}` : ""}
								</Text>
							</Pressable>
							<View style={styles.actions}>
								<Pressable
									style={styles.action}
									onPress={() => void run(l, () => api.loops.runNow(l.id))}
									disabled={busy === l.id}
									hitSlop={4}
								>
									{busy === l.id ? (
										<ActivityIndicator size="small" color={C.ink} />
									) : (
										<Feather name="play" size={14} color={C.ink} />
									)}
									<Text style={styles.actionText}>Run now</Text>
								</Pressable>
								<View style={styles.spacer} />
								<Pressable style={styles.iconAction} onPress={() => onEdit(l)} hitSlop={6}>
									<Feather name="edit-2" size={15} color={C.muted} />
								</Pressable>
								<Pressable style={styles.iconAction} onPress={() => remove(l)} hitSlop={6}>
									<Feather name="trash-2" size={15} color={C.muted} />
								</Pressable>
								<Switch
									value={l.enabled}
									onValueChange={(v) => void run(l, () => api.loops.setEnabled(l.id, v))}
									trackColor={{ true: C.ink, false: C.line }}
									thumbColor={C.bg}
								/>
							</View>
						</View>
					);
				})}
			</View>
		</ScrollView>
	);
}

// ── Create / edit form ──

export function LoopForm({
	api,
	agents,
	projectId,
	editing,
	onClose,
	onSaved,
}: {
	api: AteamApi;
	agents: AgentDTO[];
	projectId: string | null;
	editing: LoopDTO | null;
	onClose: () => void;
	onSaved: (loops: LoopDTO[]) => void;
}) {
	const pickable = agents.length
		? agents
		: [{ id: "claude", label: "Claude Code", available: true } as AgentDTO];
	const [name, setName] = useState(editing?.title ?? "");
	const [prompt, setPrompt] = useState(editing?.prompt ?? "");
	const [followUp, setFollowUp] = useState(editing?.followUp ?? "");
	const [agentId, setAgentId] = useState(
		editing?.agentId ?? pickable.find((a) => a.available)?.id ?? pickable[0]?.id ?? "claude",
	);
	const [everyMin, setEveryMin] = useState(
		editing?.intervalMs ? String(Math.round(editing.intervalMs / 60_000)) : "60",
	);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const current = pickable.find((a) => a.id === agentId) ?? pickable[0];
	const ready = prompt.trim().length > 0 && Number(everyMin) >= 1 && (editing || projectId);

	const save = async () => {
		if (!ready) return;
		setSaving(true);
		setError(null);
		try {
			const config = { prompt: prompt.trim(), agentId, followUp: followUp.trim() };
			const intervalMs = Number(everyMin) * 60_000;
			const loops = editing
				? await api.loops.update({
						id: editing.id,
						name: name.trim() || "Loop",
						intervalMs,
						config,
					})
				: await api.loops.create({
						templateId: "agent-session",
						name: name.trim() || "Loop",
						projectId: projectId ?? undefined,
						intervalMs,
						config,
						enabled: true,
					});
			onSaved(loops);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Modal visible animationType="slide" onRequestClose={onClose}>
			<KeyboardAvoidingView
				style={styles.formRoot}
				behavior={Platform.OS === "ios" ? "padding" : undefined}
			>
				<View style={styles.formHead}>
					<Pressable onPress={onClose} hitSlop={8}>
						<Text style={styles.formCancel}>Cancel</Text>
					</Pressable>
					<Text style={styles.formTitle}>{editing ? "Edit loop" : "New loop"}</Text>
					<Pressable onPress={() => void save()} disabled={!ready || saving} hitSlop={8}>
						<Text style={[styles.formSave, (!ready || saving) && styles.formSaveOff]}>
							{saving ? "Saving…" : "Save"}
						</Text>
					</Pressable>
				</View>
				<ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
					<View style={styles.column}>
						<Text style={styles.label}>NAME</Text>
						<TextInput
							style={styles.input}
							value={name}
							onChangeText={setName}
							placeholder="Loop"
							placeholderTextColor={C.faint}
						/>
						<Text style={styles.label}>AGENT</Text>
						<Pressable style={styles.agentPill} onPress={() => setPickerOpen(true)}>
							<AgentIcon agentId={current?.id} size={14} />
							<Text style={styles.agentText}>{current?.label ?? "Agent"}</Text>
							<Text style={styles.caret}>▾</Text>
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
											<Text style={[styles.popText, !a.available && styles.popTextOff]}>
												{a.label}
												{a.available ? "" : "  (not installed)"}
											</Text>
											{a.id === agentId ? <Text style={styles.popCheck}>✓</Text> : null}
										</Pressable>
									))}
								</View>
							</Pressable>
						</Modal>
						<Text style={styles.label}>PROMPT</Text>
						<TextInput
							style={[styles.input, styles.multiline]}
							value={prompt}
							onChangeText={setPrompt}
							placeholder="What each run should do"
							placeholderTextColor={C.faint}
							multiline
						/>
						<Text style={styles.label}>FOLLOW-UP (OPTIONAL)</Text>
						<TextInput
							style={[styles.input, styles.multiline]}
							value={followUp}
							onChangeText={setFollowUp}
							placeholder="Sent once after the agent's first reply"
							placeholderTextColor={C.faint}
							multiline
						/>
						<Text style={styles.label}>EVERY (MINUTES)</Text>
						<TextInput
							style={styles.input}
							value={everyMin}
							onChangeText={setEveryMin}
							keyboardType="number-pad"
							placeholder="60"
							placeholderTextColor={C.faint}
						/>
						{error ? <Text style={styles.formError}>{error}</Text> : null}
						{!editing && !projectId ? (
							<Text style={styles.formError}>Pick a project first.</Text>
						) : null}
					</View>
				</ScrollView>
			</KeyboardAvoidingView>
		</Modal>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: C.bg },
	content: { padding: 12, paddingBottom: 30 },
	column: { width: "100%", maxWidth: CONTENT_MAX, alignSelf: "center", gap: 10 },
	head: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		marginBottom: 4,
	},
	title: { color: C.ink, fontSize: 18, fontWeight: "700" },
	newBtn: {
		flexDirection: "row",
		alignItems: "center",
		gap: 5,
		backgroundColor: C.ink,
		paddingHorizontal: 12,
		height: 32,
		borderRadius: 8,
	},
	newText: { color: "#15151a", fontSize: 13, fontWeight: "800" },
	empty: { color: C.faint, fontSize: 13, paddingVertical: 20, textAlign: "center" },
	card: {
		backgroundColor: C.surface,
		borderWidth: 1,
		borderColor: C.line,
		borderRadius: 12,
		padding: 12,
		gap: 8,
	},
	cardOff: { opacity: 0.6 },
	cardTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
	cardTitle: { flex: 1, color: C.ink, fontSize: 15, fontWeight: "700" },
	cadence: { color: C.muted, fontSize: 12 },
	prompt: { color: C.muted, fontSize: 13, marginTop: 6 },
	meta: { color: C.faint, fontSize: 12, marginTop: 6 },
	ok: { color: C.muted },
	err: { color: C.red },
	actions: { flexDirection: "row", alignItems: "center", gap: 8 },
	action: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		height: 32,
		paddingHorizontal: 10,
		borderRadius: 8,
		backgroundColor: C.sunken,
		borderWidth: 1,
		borderColor: C.line,
	},
	actionText: { color: C.ink, fontSize: 12, fontWeight: "600" },
	iconAction: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
	spacer: { flex: 1 },
	// form
	formRoot: { flex: 1, backgroundColor: C.bg, paddingTop: 56 },
	formHead: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 16,
		paddingBottom: 12,
		borderBottomWidth: 1,
		borderBottomColor: C.line,
	},
	formTitle: { color: C.ink, fontSize: 16, fontWeight: "700" },
	formCancel: { color: C.muted, fontSize: 15 },
	formSave: { color: C.ink, fontSize: 15, fontWeight: "700" },
	formSaveOff: { opacity: 0.35 },
	formContent: { padding: 16, paddingBottom: 40 },
	label: { color: C.ink, fontSize: 10, fontWeight: "700", letterSpacing: 1.1, marginTop: 6 },
	input: {
		color: C.ink,
		fontSize: 15,
		backgroundColor: C.sunken,
		borderWidth: 1,
		borderColor: C.line,
		borderRadius: 10,
		paddingHorizontal: 12,
		paddingVertical: 10,
		minHeight: 42,
	},
	multiline: { minHeight: 90, textAlignVertical: "top" },
	agentPill: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		alignSelf: "flex-start",
		paddingHorizontal: 12,
		height: 36,
		borderRadius: 8,
		backgroundColor: C.sunken,
		borderWidth: 1,
		borderColor: C.line,
	},
	agentText: { color: C.ink, fontSize: 14 },
	caret: { color: C.muted, fontSize: 10 },
	backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 24 },
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
	popText: { flex: 1, color: C.ink, fontSize: 15 },
	popTextOff: { color: C.faint },
	popCheck: { color: C.ink, fontSize: 15, fontWeight: "700" },
	formError: { color: C.red, fontSize: 13 },
});
