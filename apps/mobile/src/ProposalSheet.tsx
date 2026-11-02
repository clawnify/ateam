// A task the box's Lead proposed, started from the phone: the New task sheet,
// filled in from the proposal and editable, the phone's version of the dialog
// the desktop opens. Nothing starts until Start. Auto mode stays off even when
// the Lead suggested it: the Lead acts on text it read from tasks and the web,
// so only the user switches it on (the desktop's rule, Proposals in the wiki).
import type { AgentDTO, LeadItem } from "@ateam/protocol";
import { useState } from "react";
import {
	KeyboardAvoidingView,
	Modal,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { AgentIcon } from "./AgentIcon";
import { C, CONTENT_MAX } from "./theme";

export type ProposalItem = Extract<LeadItem, { kind: "proposal" }>;

export interface ProposalStart {
	projectId: string;
	name: string;
	prompt: string;
	agentId: string;
	yolo: boolean;
	/** Files attached in the Lead's chat: already on this box, in its folder. */
	files: string[];
}

export function ProposalSheet({
	item,
	agents,
	onClose,
	onStart,
}: {
	item: ProposalItem;
	agents: AgentDTO[];
	onClose: () => void;
	/** Rejects with words for the user when the task can't be started. */
	onStart: (input: ProposalStart) => Promise<void>;
}) {
	const p = item.proposal;
	const pickable = agents.length
		? agents
		: [{ id: "claude", label: "Claude Code", available: true } as AgentDTO];
	const first = pickable.find((a) => a.available)?.id ?? pickable[0]?.id ?? "claude";
	const [name, setName] = useState(p.name);
	const [prompt, setPrompt] = useState(p.prompt);
	const [agentId, setAgentId] = useState(
		p.agentId && pickable.some((a) => a.id === p.agentId && a.available) ? p.agentId : first,
	);
	const [yolo, setYolo] = useState(false);
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const files = item.files ?? [];
	const ready = prompt.trim().length > 0 && !starting;

	const start = async () => {
		if (!ready) return;
		setStarting(true);
		setError(null);
		try {
			await onStart({
				projectId: item.projectId,
				name: name.trim() || p.name,
				prompt: prompt.trim(),
				agentId,
				yolo,
				files,
			});
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setStarting(false);
		}
	};

	return (
		<Modal visible animationType="slide" onRequestClose={onClose}>
			<KeyboardAvoidingView
				style={styles.root}
				behavior={Platform.OS === "ios" ? "padding" : undefined}
			>
				<View style={styles.head}>
					<Pressable onPress={onClose} hitSlop={8}>
						<Text style={styles.cancel}>Cancel</Text>
					</Pressable>
					<Text style={styles.title}>New task</Text>
					<Pressable onPress={() => void start()} disabled={!ready} hitSlop={8}>
						<Text style={[styles.save, !ready && styles.saveOff]}>
							{starting ? "Starting…" : "Start"}
						</Text>
					</Pressable>
				</View>
				<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
					<View style={styles.column}>
						<Text style={styles.meta}>
							Proposed by the Lead in {item.projectName}
							{p.reason ? `: ${p.reason}` : "."}
						</Text>
						<Text style={styles.label}>NAME</Text>
						<TextInput
							style={styles.input}
							value={name}
							onChangeText={setName}
							placeholder="Task"
							placeholderTextColor={C.faint}
						/>
						<Text style={styles.label}>AGENT</Text>
						<View style={styles.agents}>
							{pickable.map((a) => {
								const on = a.id === agentId;
								return (
									<Pressable
										key={a.id}
										style={[styles.agent, on && styles.agentOn, !a.available && styles.off]}
										onPress={() => setAgentId(a.id)}
										disabled={!a.available}
										accessibilityRole="radio"
										accessibilityState={{ selected: on, disabled: !a.available }}
									>
										<AgentIcon agentId={a.id} size={14} />
										<Text style={styles.agentText}>{a.label.replace(/ Code$/, "")}</Text>
									</Pressable>
								);
							})}
						</View>
						<Text style={styles.label}>MODE</Text>
						<Pressable
							style={[styles.agent, styles.mode, yolo && styles.auto]}
							onPress={() => setYolo((v) => !v)}
							accessibilityRole="switch"
							accessibilityState={{ checked: yolo }}
						>
							<Text style={[styles.agentText, yolo && { color: C.amber }]}>
								{yolo ? "auto: on" : "auto: off"}
							</Text>
						</Pressable>
						{p.yolo ? (
							<Text style={styles.help}>
								The Lead suggested Auto mode. It stays off unless you switch it on.
							</Text>
						) : null}
						<Text style={styles.label}>PROMPT</Text>
						<TextInput
							style={[styles.input, styles.multiline]}
							value={prompt}
							onChangeText={setPrompt}
							placeholder="The agent's first instruction"
							placeholderTextColor={C.faint}
							multiline
						/>
						{files.length ? (
							<Text style={styles.help}>
								{files.length === 1
									? "1 file from the chat goes with it."
									: `${files.length} files from the chat go with it.`}
							</Text>
						) : null}
						{error ? <Text style={styles.error}>{error}</Text> : null}
					</View>
				</ScrollView>
			</KeyboardAvoidingView>
		</Modal>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: C.bg, paddingTop: 56 },
	head: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 16,
		paddingBottom: 12,
		borderBottomWidth: 1,
		borderBottomColor: C.line,
	},
	title: { color: C.ink, fontSize: 16, fontWeight: "700" },
	cancel: { color: C.muted, fontSize: 15 },
	save: { color: C.ink, fontSize: 15, fontWeight: "700" },
	saveOff: { opacity: 0.35 },
	content: { padding: 16, paddingBottom: 40 },
	column: { width: "100%", maxWidth: CONTENT_MAX, alignSelf: "center", gap: 10 },
	meta: { color: C.muted, fontSize: 13, lineHeight: 18 },
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
	multiline: { minHeight: 140, textAlignVertical: "top" },
	agents: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
	agent: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		paddingHorizontal: 12,
		height: 36,
		borderRadius: 8,
		backgroundColor: C.sunken,
		borderWidth: 1,
		borderColor: C.line,
	},
	agentOn: { borderColor: C.ink },
	mode: { alignSelf: "flex-start" },
	auto: { borderColor: C.amber, backgroundColor: "rgba(251,191,36,0.13)" },
	agentText: { color: C.ink, fontSize: 14 },
	off: { opacity: 0.4 },
	help: { color: C.faint, fontSize: 12 },
	error: { color: C.red, fontSize: 13 },
});
