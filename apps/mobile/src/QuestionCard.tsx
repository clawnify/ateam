// A task's agent waiting on the user (TaskDTO.question): an ask_user question,
// Claude Code asking to use a tool, or its AskUserQuestion. The phone's version
// of the desktop's QuestionCard: options as buttons, choices with what they
// mean, a checklist for "select many", a typed answer when one is accepted,
// and dismiss for one answered somewhere else. The answer reaches the agent as
// a message from the user. A page drawn with the question shows on the desktop.
import type { QuestionChoiceDTO, TaskDTO } from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { AgentIcon } from "./AgentIcon";
import { LeadMarkdown } from "./LeadMarkdown";
import { C } from "./theme";

export interface QuestionAnswer {
	taskId: string;
	questionId: string;
	answer: string | string[] | null;
}

const INK_ON_WHITE = "#15151a";

function ago(at: number): string {
	const mins = Math.round((Date.now() - at) / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

const cleanError = (e: unknown) =>
	(e instanceof Error ? e.message : String(e)).replace(
		/^Error invoking remote method '[^']+': /,
		"",
	);

function Choice({
	choice,
	disabled,
	onPick,
}: {
	choice: QuestionChoiceDTO;
	disabled: boolean;
	onPick: () => void;
}) {
	return (
		<Pressable
			style={[styles.choice, choice.recommended && styles.choiceRecommended]}
			disabled={disabled}
			onPress={onPick}
			accessibilityRole="button"
			accessibilityLabel={choice.label}
		>
			<View style={styles.choiceHead}>
				<Text style={styles.choiceLabel}>{choice.label}</Text>
				{choice.recommended && <Text style={styles.badge}>Recommended</Text>}
				{choice.risk && <Text style={styles.risk}>{choice.risk} risk</Text>}
			</View>
			{choice.description ? <Text style={styles.choiceText}>{choice.description}</Text> : null}
			{choice.pros?.map((p) => (
				<Text key={`+${p}`} style={styles.choiceText}>
					+ {p}
				</Text>
			))}
			{choice.cons?.map((c) => (
				<Text key={`-${c}`} style={styles.choiceText}>
					− {c}
				</Text>
			))}
		</Pressable>
	);
}

function Checklist({
	choices,
	disabled,
	onSend,
}: {
	choices: QuestionChoiceDTO[];
	disabled: boolean;
	onSend: (labels: string[]) => void;
}) {
	const [ticked, setTicked] = useState(
		() => new Set(choices.filter((c) => c.checked).map((c) => c.label)),
	);
	const toggle = (label: string) =>
		setTicked((s) => {
			const next = new Set(s);
			if (!next.delete(label)) next.add(label);
			return next;
		});
	return (
		<View style={styles.gap}>
			{choices.map((c) => {
				const on = ticked.has(c.label);
				return (
					<Pressable
						key={c.label}
						style={styles.checkRow}
						onPress={() => toggle(c.label)}
						disabled={disabled}
						accessibilityRole="checkbox"
						accessibilityState={{ checked: on }}
					>
						<Feather name={on ? "check-square" : "square"} size={18} color={C.ink} />
						<View style={styles.flex}>
							<Text style={styles.choiceLabel}>{c.label}</Text>
							{c.description ? <Text style={styles.choiceText}>{c.description}</Text> : null}
						</View>
					</Pressable>
				);
			})}
			<Pressable
				style={[styles.primary, disabled && styles.off]}
				disabled={disabled}
				onPress={() => onSend(choices.map((c) => c.label).filter((l) => ticked.has(l)))}
			>
				<Text style={styles.primaryText}>Send</Text>
			</Pressable>
		</View>
	);
}

export function QuestionCard({
	task,
	onOpenTask,
	onAnswer,
}: {
	task: TaskDTO;
	onOpenTask?: (task: TaskDTO) => void;
	onAnswer: (input: QuestionAnswer) => Promise<unknown>;
}) {
	const q = task.question;
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (!q) return null;

	const answer = async (value: string | string[] | null) => {
		setSending(true);
		setError(null);
		try {
			await onAnswer({ taskId: task.id, questionId: q.id, answer: value });
			setText("");
		} catch (e) {
			setError(cleanError(e));
		} finally {
			setSending(false);
		}
	};

	return (
		<View style={styles.card} accessibilityLabel={`Question from ${task.name}`}>
			<View style={styles.head}>
				<Pressable
					style={styles.taskChip}
					onPress={onOpenTask ? () => onOpenTask(task) : undefined}
					disabled={!onOpenTask}
					accessibilityRole={onOpenTask ? "link" : undefined}
				>
					<AgentIcon agentId={task.agentId} size={12} />
					<Text style={styles.taskName} numberOfLines={1}>
						{task.name}
					</Text>
				</Pressable>
				{q.kind === "permission" && <Text style={styles.kind}>permission</Text>}
				<Text style={styles.when}>{ago(q.askedAt)}</Text>
				<Pressable
					onPress={() => void answer(null)}
					disabled={sending}
					hitSlop={10}
					accessibilityRole="button"
					accessibilityLabel="Dismiss: answered somewhere else"
				>
					<Feather name="x" size={16} color={C.muted} />
				</Pressable>
			</View>
			<LeadMarkdown text={q.text} />
			{q.pageId && task.page?.id === q.pageId ? (
				<Text style={styles.note}>It drew a page for this: open it on your Mac to see it.</Text>
			) : null}
			{q.select === "many" && q.choices ? (
				// Keyed by question: the next question of a call must not keep these ticks.
				<Checklist
					key={q.id}
					choices={q.choices}
					disabled={sending}
					onSend={(t) => void answer(t)}
				/>
			) : q.choices ? (
				<View style={styles.gap}>
					{q.choices.map((c) => (
						<Choice
							key={c.label}
							choice={c}
							disabled={sending}
							onPick={() => void answer(c.label)}
						/>
					))}
				</View>
			) : q.options.length > 0 ? (
				<View style={styles.options}>
					{q.options.map((o, i) => (
						<Pressable
							key={o}
							style={[i === 0 ? styles.primary : styles.secondary, sending && styles.off]}
							disabled={sending}
							onPress={() => void answer(o)}
							accessibilityRole="button"
						>
							<Text style={i === 0 ? styles.primaryText : styles.secondaryText}>{o}</Text>
						</Pressable>
					))}
				</View>
			) : null}
			{q.allowText && q.select !== "many" ? (
				<View style={styles.reply}>
					<TextInput
						style={styles.input}
						value={text}
						onChangeText={setText}
						placeholder={q.options.length ? "Or type an answer" : "Type your answer"}
						placeholderTextColor={C.faint}
						editable={!sending}
						multiline
						accessibilityLabel="Your answer"
					/>
					<Pressable
						style={[styles.send, (!text.trim() || sending) && styles.off]}
						disabled={!text.trim() || sending}
						onPress={() => void answer(text)}
						accessibilityRole="button"
						accessibilityLabel="Send answer"
					>
						<Feather name="arrow-up" size={16} color={INK_ON_WHITE} />
					</Pressable>
				</View>
			) : null}
			{error ? <Text style={styles.error}>{error}</Text> : null}
		</View>
	);
}

const styles = StyleSheet.create({
	card: {
		backgroundColor: C.surface,
		borderColor: C.line,
		borderWidth: StyleSheet.hairlineWidth,
		borderRadius: 12,
		padding: 12,
		gap: 10,
	},
	head: { flexDirection: "row", alignItems: "center", gap: 8 },
	taskChip: {
		flexShrink: 1,
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		paddingHorizontal: 8,
		paddingVertical: 4,
		borderRadius: 6,
		backgroundColor: C.sunken,
	},
	taskName: { color: C.ink, fontSize: 13, fontWeight: "600", flexShrink: 1 },
	kind: { color: C.amber, fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
	when: { color: C.faint, fontSize: 12, marginLeft: "auto" },
	note: { color: C.muted, fontSize: 13 },
	gap: { gap: 8 },
	flex: { flex: 1, gap: 2 },
	options: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
	choice: {
		borderColor: C.line,
		borderWidth: StyleSheet.hairlineWidth,
		borderRadius: 10,
		padding: 10,
		gap: 4,
	},
	choiceRecommended: { borderColor: C.ink },
	choiceHead: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
	choiceLabel: { color: C.ink, fontSize: 15, fontWeight: "600" },
	choiceText: { color: C.muted, fontSize: 13, lineHeight: 18 },
	badge: {
		color: INK_ON_WHITE,
		backgroundColor: C.ink,
		fontSize: 10,
		fontWeight: "700",
		paddingHorizontal: 6,
		paddingVertical: 2,
		borderRadius: 5,
		overflow: "hidden",
	},
	risk: { color: C.amber, fontSize: 11, fontWeight: "600" },
	checkRow: { flexDirection: "row", gap: 10, alignItems: "flex-start", paddingVertical: 4 },
	primary: {
		backgroundColor: C.ink,
		borderRadius: 8,
		paddingHorizontal: 14,
		paddingVertical: 9,
		alignItems: "center",
	},
	primaryText: { color: INK_ON_WHITE, fontSize: 14, fontWeight: "700" },
	secondary: {
		backgroundColor: C.sunken,
		borderRadius: 8,
		paddingHorizontal: 14,
		paddingVertical: 9,
		alignItems: "center",
	},
	secondaryText: { color: C.ink, fontSize: 14, fontWeight: "600" },
	off: { opacity: 0.45 },
	reply: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
	input: {
		flex: 1,
		color: C.ink,
		fontSize: 15,
		backgroundColor: C.sunken,
		borderRadius: 8,
		paddingHorizontal: 10,
		paddingTop: 8,
		paddingBottom: 8,
		maxHeight: 120,
	},
	send: {
		width: 34,
		height: 34,
		borderRadius: 17,
		backgroundColor: C.ink,
		alignItems: "center",
		justifyContent: "center",
	},
	error: { color: C.red, fontSize: 13 },
});
