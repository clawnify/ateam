// The Lead chat on the phone: one conversation with a coordinator that reads
// this box's board and steers its agents. It runs ON the box (the engine's own
// Lead, packages/server/src/lead/engine-lead.ts), so it works with the Mac off,
// sees this box's tasks only, and is a different conversation from the Mac's.
//
// The phone's counterpart of the desktop's LeadChat, sharing its reducer, block
// folding and tool words (lead-view.ts in @ateam/protocol). Not here yet:
// opening a proposal's dialog (a proposal is a card to read or dismiss), and
// pages, which show on the Mac.
import {
	applyLeadEvent,
	findLeadTask,
	type LeadAgentItem,
	type LeadBlock,
	type LeadClient,
	type LeadFile,
	type LeadItem,
	type LeadPermissionAnswer,
	type LeadSnapshot,
	type LeadTaskRef,
	type LeadToolItem,
	leadToolResult,
	leadToolStep,
	leadToolTask,
	summarizeLeadTools,
	type TaskDTO,
	toLeadBlocks,
} from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	FlatList,
	Image,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { AgentIcon } from "./AgentIcon";
import { LeadMarkdown } from "./LeadMarkdown";
import { attachmentName } from "./lead-attach";
import { type QuestionAnswer, QuestionCard } from "./QuestionCard";
import { C, CONTENT_MAX } from "./theme";

const INK_ON_WHITE = "#15151a";

const SUGGESTIONS = [
	"What's on the board?",
	"Which tasks need me?",
	"What did the last finished task say?",
];

interface Pending {
	file: LeadFile;
	uri: string;
}

// Kept across tab switches (the screen unmounts) and reconnects, like the
// desktop's unsent message. Previews by the box path of a photo sent from here.
let draftText = "";
let draftFiles: Pending[] = [];
const previews = new Map<string, string>();

const cleanError = (e: unknown) => (e instanceof Error ? e.message : String(e));

function ago(at: number): string {
	const mins = Math.round((Date.now() - at) / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m`;
	const hours = Math.round(mins / 60);
	return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

interface Ctx {
	tasks: TaskDTO[];
	openTask: (ref: string) => void;
	knowsTask: (ref: string) => boolean;
}

function TaskChip({ task, ctx }: { task: LeadTaskRef; ctx: Ctx }) {
	const known = ctx.knowsTask(task.taskId);
	return (
		<Pressable
			style={styles.chip}
			onPress={known ? () => ctx.openTask(task.taskId) : undefined}
			disabled={!known}
			accessibilityRole={known ? "link" : undefined}
			accessibilityLabel={`Open ${task.name}`}
		>
			<AgentIcon agentId={task.agentId} size={11} />
			<Text style={styles.chipText} numberOfLines={1}>
				{task.name}
			</Text>
		</Pressable>
	);
}

function Md({ text, ctx }: { text: string; ctx: Ctx }) {
	return <LeadMarkdown text={text} onTaskLink={ctx.openTask} knowsTask={ctx.knowsTask} />;
}

function Tools({ tools, ctx }: { tools: LeadToolItem[]; ctx: Ctx }) {
	const [open, setOpen] = useState(false);
	const running = tools.some((t) => t.result === undefined);
	const failed = tools.some((t) => t.isError);
	const touched = [
		...new Map(
			tools
				.map((t) => leadToolTask(t, ctx.tasks))
				.filter((t): t is TaskDTO => t != null)
				.map((t) => [t.id, t]),
		).values(),
	];
	return (
		<View style={styles.tools}>
			<Pressable
				style={styles.toolsHead}
				onPress={() => setOpen((o) => !o)}
				accessibilityRole="button"
				accessibilityState={{ expanded: open }}
			>
				{running ? (
					<ActivityIndicator size="small" color={C.muted} />
				) : (
					<Feather name={failed ? "alert-circle" : "check"} size={13} color={C.muted} />
				)}
				<Text style={styles.toolsText} numberOfLines={open ? undefined : 1}>
					{summarizeLeadTools(tools, ctx.tasks)}
				</Text>
				<Feather name={open ? "chevron-up" : "chevron-down"} size={14} color={C.faint} />
			</Pressable>
			{touched.length > 0 && (
				<View style={styles.chips}>
					{touched.map((t) => (
						<TaskChip
							key={t.id}
							task={{ taskId: t.id, name: t.name, agentId: t.agentId }}
							ctx={ctx}
						/>
					))}
				</View>
			)}
			{open &&
				tools.map((t) => (
					<View key={t.id} style={styles.step}>
						<Text style={styles.stepLabel}>{leadToolStep(t, ctx.tasks)}</Text>
						{t.result !== undefined && (
							<Text style={[styles.stepResult, t.isError && styles.errorText]} numberOfLines={3}>
								{leadToolResult(t)}
							</Text>
						)}
					</View>
				))}
		</View>
	);
}

function AgentReply({
	item,
	ctx,
	onReply,
}: {
	item: LeadAgentItem;
	ctx: Ctx;
	onReply: (taskId: string, text: string) => Promise<void>;
}) {
	const long = item.text.length > 500;
	const [expanded, setExpanded] = useState(false);
	const [replying, setReplying] = useState(false);
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const send = async () => {
		if (!text.trim()) return;
		setSending(true);
		setError(null);
		try {
			await onReply(item.task.taskId, text);
			setText("");
			setReplying(false);
		} catch (e) {
			setError(cleanError(e));
		} finally {
			setSending(false);
		}
	};
	return (
		<View style={styles.card}>
			<View style={styles.cardHead}>
				<TaskChip task={item.task} ctx={ctx} />
				<Text style={styles.cardMeta}>replied · {ago(item.at)}</Text>
			</View>
			<View style={long && !expanded ? styles.clipped : undefined}>
				<Md text={item.text} ctx={ctx} />
			</View>
			<View style={styles.cardActions}>
				{long && (
					<Pressable onPress={() => setExpanded((x) => !x)} hitSlop={8}>
						<Text style={styles.action}>{expanded ? "Show less" : "Show more"}</Text>
					</Pressable>
				)}
				{!replying && (
					<Pressable onPress={() => setReplying(true)} hitSlop={8} accessibilityRole="button">
						<Text style={styles.action}>Reply</Text>
					</Pressable>
				)}
			</View>
			{replying && (
				<View style={styles.replyRow}>
					<TextInput
						style={styles.replyInput}
						value={text}
						onChangeText={setText}
						placeholder={`Reply to ${item.task.name}`}
						placeholderTextColor={C.faint}
						editable={!sending}
						multiline
						autoFocus
					/>
					<Pressable
						style={[styles.sendSmall, (!text.trim() || sending) && styles.off]}
						disabled={!text.trim() || sending}
						onPress={() => void send()}
						accessibilityRole="button"
						accessibilityLabel="Send reply"
					>
						<Feather name="arrow-up" size={15} color={INK_ON_WHITE} />
					</Pressable>
				</View>
			)}
			{error && <Text style={styles.errorText}>{error}</Text>}
		</View>
	);
}

const ANSWERED: Record<string, string> = {
	allow: "Allowed",
	always: "Always allowed",
	deny: "Denied",
	cancelled: "No longer waiting",
};

function Permission({
	item,
	onAnswer,
}: {
	item: Extract<LeadItem, { kind: "permission" }>;
	onAnswer: (id: string, answer: LeadPermissionAnswer) => Promise<void>;
}) {
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const answer = async (a: LeadPermissionAnswer) => {
		setSending(true);
		setError(null);
		try {
			await onAnswer(item.id, a);
		} catch (e) {
			setError(cleanError(e));
		} finally {
			setSending(false);
		}
	};
	return (
		<View style={[styles.card, !item.answer && styles.cardWaiting]}>
			<View style={styles.cardHead}>
				<Feather name="shield" size={13} color={C.amber} />
				<Text style={styles.cardTitle}>The Lead asks</Text>
			</View>
			<LeadMarkdown text={item.text} />
			{item.answer ? (
				<Text style={styles.cardMeta}>{ANSWERED[item.answer] ?? item.answer}</Text>
			) : (
				<View style={styles.buttons}>
					<Pressable
						style={[styles.primary, sending && styles.off]}
						disabled={sending}
						onPress={() => void answer("allow")}
					>
						<Text style={styles.primaryText}>Allow</Text>
					</Pressable>
					{item.canAlways && (
						<Pressable
							style={[styles.secondary, sending && styles.off]}
							disabled={sending}
							onPress={() => void answer("always")}
						>
							<Text style={styles.secondaryText}>Always allow</Text>
						</Pressable>
					)}
					<Pressable
						style={[styles.secondary, sending && styles.off]}
						disabled={sending}
						onPress={() => void answer("deny")}
					>
						<Text style={styles.secondaryText}>Deny</Text>
					</Pressable>
				</View>
			)}
			{!item.answer && item.always ? (
				<Text style={styles.cardMeta}>Always allow adds the rule {item.always}</Text>
			) : null}
			{error && <Text style={styles.errorText}>{error}</Text>}
		</View>
	);
}

const OUTCOME: Record<string, string> = {
	created: "Created",
	dismissed: "Dismissed",
	replaced: "Replaced by a newer proposal",
};

function Proposal({
	item,
	ctx,
	onDismiss,
}: {
	item: Extract<LeadItem, { kind: "proposal" }>;
	ctx: Ctx;
	onDismiss: (id: string) => Promise<void>;
}) {
	const p = item.proposal;
	const [open, setOpen] = useState(false);
	const schedule = p.everyMinutes
		? `every ${p.everyMinutes} min`
		: p.dailyAt
			? `every day at ${p.dailyAt}`
			: null;
	return (
		<View style={styles.card}>
			<View style={styles.cardHead}>
				<Feather name={p.kind === "loop" ? "repeat" : "plus-square"} size={13} color={C.muted} />
				<Text style={styles.cardTitle}>
					Proposes {p.kind === "loop" ? "a loop" : "a task"} in {item.projectName}
				</Text>
			</View>
			<Text style={styles.proposalName} selectable>
				{p.name}
			</Text>
			{p.reason ? <Text style={styles.cardBody}>{p.reason}</Text> : null}
			{schedule ? <Text style={styles.cardMeta}>{schedule}</Text> : null}
			<Pressable onPress={() => setOpen((o) => !o)} hitSlop={8}>
				<Text style={styles.action}>{open ? "Hide the prompt" : "Show the prompt"}</Text>
			</Pressable>
			{open && (
				<Text style={styles.prompt} selectable>
					{p.prompt}
				</Text>
			)}
			{item.outcome ? (
				<View style={styles.cardHead}>
					<Text style={styles.cardMeta}>{OUTCOME[item.outcome]}</Text>
					{item.task && <TaskChip task={item.task} ctx={ctx} />}
				</View>
			) : (
				<View style={styles.buttons}>
					<Text style={[styles.cardMeta, styles.flex]}>
						Starting a proposal from the phone isn't there yet.
					</Text>
					<Pressable style={styles.secondary} onPress={() => void onDismiss(item.id)}>
						<Text style={styles.secondaryText}>Dismiss</Text>
					</Pressable>
				</View>
			)}
		</View>
	);
}

function UserMessage({ item, ctx }: { item: Extract<LeadItem, { kind: "user" }>; ctx: Ctx }) {
	return (
		<View style={styles.userWrap}>
			{item.to && (
				<View style={styles.userTo}>
					<Text style={styles.cardMeta}>to</Text>
					<TaskChip task={item.to} ctx={ctx} />
				</View>
			)}
			{item.files?.length ? (
				<View style={styles.files}>
					{item.files.map((f) => {
						const uri = previews.get(f.path);
						return uri && f.image ? (
							<Image key={f.path} source={{ uri }} style={styles.thumb} />
						) : (
							<View key={f.path} style={styles.fileChip}>
								<Feather name={f.image ? "image" : "file"} size={12} color={C.muted} />
								<Text style={styles.fileName} numberOfLines={1}>
									{f.name}
								</Text>
							</View>
						);
					})}
				</View>
			) : null}
			{item.text ? (
				<View style={styles.user}>
					<Text style={styles.userText} selectable>
						{item.text}
					</Text>
				</View>
			) : null}
		</View>
	);
}

function Block({ block, ctx, lead }: { block: LeadBlock; ctx: Ctx; lead: LeadClient }) {
	if (block.kind === "tools") return <Tools tools={block.tools} ctx={ctx} />;
	if (block.kind === "agents")
		return (
			<View style={styles.gap}>
				{block.replies.map((r) => (
					<AgentReply key={r.id} item={r} ctx={ctx} onReply={lead.reply} />
				))}
			</View>
		);
	const item = block.item;
	switch (item.kind) {
		case "user":
			return <UserMessage item={item} ctx={ctx} />;
		case "assistant":
			return <Md text={item.text} ctx={ctx} />;
		case "permission":
			return <Permission item={item} onAnswer={lead.permission} />;
		case "proposal":
			return <Proposal item={item} ctx={ctx} onDismiss={lead.dismissProposal} />;
		case "page":
			return (
				<View style={styles.inlineRow}>
					<TaskChip task={item.task} ctx={ctx} />
					<Text style={styles.cardMeta}>made a page, "{item.title}": open it on your Mac</Text>
				</View>
			);
		case "notice":
			return (
				<View style={styles.inlineRow}>
					<Text style={[styles.notice, item.tone === "error" && styles.errorText]}>
						{item.text}
					</Text>
					{item.task && <TaskChip task={item.task} ctx={ctx} />}
				</View>
			);
		default:
			return null;
	}
}

/** Every agent on this box waiting on the user: they live on the tasks, not in
 *  the conversation, so they sit above the composer. Folded to a line by default. */
function Waiting({
	tasks,
	ctx,
	onAnswer,
}: {
	tasks: TaskDTO[];
	ctx: Ctx;
	onAnswer: (input: QuestionAnswer) => Promise<unknown>;
}) {
	const [open, setOpen] = useState(false);
	const first = tasks[0];
	if (!first?.question) return null;
	const headline = first.question.text.split("\n").find((l) => l.trim()) ?? "";
	return (
		<View style={styles.waiting}>
			<Pressable
				style={styles.waitingHead}
				onPress={() => setOpen((o) => !o)}
				accessibilityRole="button"
				accessibilityState={{ expanded: open }}
			>
				<View style={styles.waitingDot} />
				<Text style={styles.waitingTitle}>Waiting on you · {tasks.length}</Text>
				{!open && (
					<Text style={styles.waitingLine} numberOfLines={1}>
						{first.name}: {headline.replace(/[*_`#]/g, "")}
					</Text>
				)}
				<Feather name={open ? "chevron-down" : "chevron-up"} size={15} color={C.muted} />
			</Pressable>
			{open && (
				<ScrollView style={styles.waitingList} contentContainerStyle={styles.gap}>
					{tasks.map((t) => (
						<QuestionCard
							key={t.id}
							task={t}
							onOpenTask={(task) => ctx.openTask(task.id)}
							onAnswer={onAnswer}
						/>
					))}
				</ScrollView>
			)}
		</View>
	);
}

export function LeadScreen({
	lead,
	supported,
	boxVersion,
	tasks,
	onOpenTask,
	onUpdateBox,
	updating,
}: {
	lead: LeadClient | null;
	/** The box serves its own Lead (protocol v24+). */
	supported: boolean;
	boxVersion: number;
	/** Every task on this box. */
	tasks: TaskDTO[];
	onOpenTask: (task: TaskDTO) => void;
	onUpdateBox: () => void;
	updating: boolean;
}) {
	const [snap, setSnap] = useState<LeadSnapshot | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [reload, setReload] = useState(0);
	const [text, setTextState] = useState(draftText);
	const [files, setFilesState] = useState<Pending[]>(draftFiles);
	const [attaching, setAttaching] = useState(false);
	const [note, setNote] = useState<string | null>(null);
	const setText = (t: string) => {
		draftText = t;
		setTextState(t);
	};
	const setFiles = (f: Pending[]) => {
		draftFiles = f;
		setFilesState(f);
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: reload re-reads after a failed load
	useEffect(() => {
		if (!lead || !supported) return;
		let live = true;
		setSnap(null);
		setLoadError(null);
		// Listening first: the box starts pushing on our first call, and anything
		// pushed before the snapshot's reply is already in it.
		const off = lead.onEvent((e) => setSnap((s) => (s ? applyLeadEvent(s, e) : s)));
		lead.snapshot().then(
			(s) => live && setSnap(s),
			(e) => live && setLoadError(cleanError(e)),
		);
		return () => {
			live = false;
			off();
		};
	}, [lead, supported, reload]);

	const openTask = useCallback(
		(ref: string) => {
			const t = findLeadTask(tasks, ref);
			if (t) onOpenTask(t);
		},
		[tasks, onOpenTask],
	);
	const ctx = useMemo<Ctx>(
		() => ({ tasks, openTask, knowsTask: (ref) => findLeadTask(tasks, ref) != null }),
		[tasks, openTask],
	);
	const blocks = useMemo(() => (snap ? toLeadBlocks(snap.items) : []), [snap]);
	// Newest first: the list is inverted so it opens at the bottom and stays there.
	const rows = useMemo(() => [...blocks].reverse(), [blocks]);
	const asking = useMemo(
		() =>
			tasks
				.filter((t) => t.question)
				.sort((a, b) => (b.question?.askedAt ?? 0) - (a.question?.askedAt ?? 0)),
		[tasks],
	);

	if (!supported)
		return (
			<View style={styles.center}>
				<Feather name="message-circle" size={22} color={C.muted} />
				<Text style={styles.centerTitle}>The Lead needs a newer Ateam on this box</Text>
				<Text style={styles.centerText}>
					This box runs v{boxVersion}. The Lead chat runs on the box itself from v24, so it works
					with your Mac off.
				</Text>
				<Pressable
					style={[styles.primary, updating && styles.off]}
					onPress={onUpdateBox}
					disabled={updating}
				>
					<Text style={styles.primaryText}>{updating ? "Updating…" : "Update box"}</Text>
				</Pressable>
			</View>
		);
	if (!lead) return null;

	const busy = snap?.busy ?? false;
	const last = blocks[blocks.length - 1];
	const toolRunning = last?.kind === "tools" && last.tools.some((t) => t.result === undefined);
	const canSend = (text.trim().length > 0 || files.length > 0) && !attaching && snap !== null;

	const send = async (body = text, attach = files) => {
		if (!body.trim() && !attach.length) return;
		setText("");
		setFiles([]);
		setNote(null);
		try {
			await lead.send(
				body,
				attach.map((f) => f.file.path),
			);
		} catch (e) {
			// Put it back rather than lose it.
			setText(body);
			setFiles(attach);
			setNote(cleanError(e));
		}
	};

	const attach = async () => {
		setNote(null);
		let res: ImagePicker.ImagePickerResult;
		try {
			res = await ImagePicker.launchImageLibraryAsync({
				mediaTypes: ["images"],
				base64: true,
				quality: 0.7,
				allowsMultipleSelection: true,
				selectionLimit: 5,
				// JPEG rather than HEIC: the Lead's agent can read a JPEG.
				preferredAssetRepresentationMode:
					ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
			});
		} catch (e) {
			setNote(cleanError(e));
			return;
		}
		if (res.canceled) return;
		setAttaching(true);
		const added: Pending[] = [];
		try {
			for (const a of res.assets) {
				if (!a.base64) continue;
				const file = await lead.attachBytes(attachmentName(a), a.base64);
				previews.set(file.path, a.uri);
				added.push({ file, uri: a.uri });
			}
		} catch (e) {
			setNote(cleanError(e));
		} finally {
			setFiles([...draftFiles, ...added]);
			setAttaching(false);
		}
	};

	const newConversation = () =>
		Alert.alert("Start a new conversation?", "This one is kept on the box.", [
			{ text: "Cancel", style: "cancel" },
			{ text: "New conversation", onPress: () => void lead.reset().catch(() => {}) },
		]);

	return (
		<View style={styles.root}>
			<View style={styles.head}>
				<Text style={styles.eyebrow}>Lead · this box</Text>
				<Pressable
					onPress={newConversation}
					disabled={!snap?.items.length}
					hitSlop={10}
					accessibilityRole="button"
					accessibilityLabel="New conversation"
				>
					<Feather name="edit" size={16} color={snap?.items.length ? C.ink : C.faint} />
				</Pressable>
			</View>

			{loadError ? (
				<View style={styles.center}>
					<Text style={styles.centerText}>Couldn't open the Lead: {loadError}</Text>
					<Pressable style={styles.secondary} onPress={() => setReload((n) => n + 1)}>
						<Text style={styles.secondaryText}>Try again</Text>
					</Pressable>
				</View>
			) : !snap ? (
				<View style={styles.center}>
					<ActivityIndicator color={C.ink} />
				</View>
			) : blocks.length === 0 && !busy ? (
				<ScrollView contentContainerStyle={styles.empty} keyboardShouldPersistTaps="handled">
					<Text style={styles.centerTitle}>Ask the Lead</Text>
					<Text style={styles.centerText}>
						Ask about this box's tasks, or tell their agents what to do. The Lead runs on this box,
						with your Claude Code there.
					</Text>
					<View style={styles.suggestions}>
						{SUGGESTIONS.map((s) => (
							<Pressable key={s} style={styles.suggestion} onPress={() => void send(s, [])}>
								<Text style={styles.suggestionText}>{s}</Text>
							</Pressable>
						))}
					</View>
				</ScrollView>
			) : (
				<FlatList
					inverted
					data={rows}
					keyExtractor={(b) => (b.kind === "item" ? b.item.id : b.id)}
					renderItem={({ item }) => (
						<View style={styles.row}>
							<Block block={item} ctx={ctx} lead={lead} />
						</View>
					)}
					// The top of an inverted list is its end: what streams in now.
					ListHeaderComponent={
						snap.draft ? (
							<View style={styles.row}>
								<Md text={snap.draft} ctx={ctx} />
							</View>
						) : busy && !toolRunning ? (
							<View style={[styles.row, styles.thinking]}>
								<ActivityIndicator size="small" color={C.muted} />
								<Text style={styles.cardMeta}>Thinking…</Text>
							</View>
						) : null
					}
					contentContainerStyle={styles.thread}
					keyboardShouldPersistTaps="handled"
					keyboardDismissMode="interactive"
				/>
			)}

			{asking.length > 0 && <Waiting tasks={asking} ctx={ctx} onAnswer={lead.answer} />}

			<View style={styles.composer}>
				{note && <Text style={[styles.errorText, styles.note]}>{note}</Text>}
				{files.length > 0 && (
					<ScrollView horizontal style={styles.pending} contentContainerStyle={styles.gapRow}>
						{files.map((f) => (
							<View key={f.file.path}>
								<Image source={{ uri: f.uri }} style={styles.thumb} />
								<Pressable
									style={styles.unattach}
									onPress={() => setFiles(draftFiles.filter((x) => x.file.path !== f.file.path))}
									hitSlop={8}
									accessibilityLabel={`Remove ${f.file.name}`}
								>
									<Feather name="x" size={11} color={INK_ON_WHITE} />
								</Pressable>
							</View>
						))}
					</ScrollView>
				)}
				<View style={styles.box}>
					<Pressable
						onPress={() => void attach()}
						disabled={attaching}
						hitSlop={8}
						style={styles.boxIcon}
						accessibilityRole="button"
						accessibilityLabel="Attach photos"
					>
						{attaching ? (
							<ActivityIndicator size="small" color={C.muted} />
						) : (
							<Feather name="paperclip" size={18} color={C.muted} />
						)}
					</Pressable>
					{/* The ⚡ a new task gets, for the box Lead's own Claude: it applies at
					    once, mid-turn included, and stays on for the next conversation. */}
					<Pressable
						onPress={() =>
							snap && void lead.setAuto(!snap.auto).catch((e) => setNote(cleanError(e)))
						}
						disabled={!snap}
						hitSlop={8}
						style={styles.boxIcon}
						accessibilityRole="switch"
						accessibilityLabel="Auto mode"
						accessibilityState={{ checked: snap?.auto === true }}
					>
						<Feather name="zap" size={17} color={snap?.auto ? C.amber : C.muted} />
					</Pressable>
					<TextInput
						style={styles.input}
						value={text}
						onChangeText={setText}
						placeholder="Message the Lead"
						placeholderTextColor={C.faint}
						multiline
						accessibilityLabel="Message the Lead"
					/>
					{busy ? (
						<Pressable
							style={styles.sendBtn}
							onPress={() => void lead.interrupt().catch(() => {})}
							accessibilityRole="button"
							accessibilityLabel="Stop"
						>
							<Feather name="square" size={13} color={INK_ON_WHITE} />
						</Pressable>
					) : (
						<Pressable
							style={[styles.sendBtn, !canSend && styles.off]}
							onPress={() => void send()}
							disabled={!canSend}
							accessibilityRole="button"
							accessibilityLabel="Send"
						>
							<Feather name="arrow-up" size={17} color={INK_ON_WHITE} />
						</Pressable>
					)}
				</View>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: C.bg },
	head: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 16,
		paddingVertical: 8,
		width: "100%",
		maxWidth: CONTENT_MAX,
		alignSelf: "center",
	},
	eyebrow: {
		color: C.muted,
		fontSize: 11,
		fontWeight: "700",
		letterSpacing: 1.2,
		textTransform: "uppercase",
	},
	thread: { paddingVertical: 8 },
	row: {
		paddingHorizontal: 16,
		paddingVertical: 6,
		width: "100%",
		maxWidth: CONTENT_MAX,
		alignSelf: "center",
	},
	thinking: { flexDirection: "row", alignItems: "center", gap: 8 },
	center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
	centerTitle: { color: C.ink, fontSize: 16, fontWeight: "700", textAlign: "center" },
	centerText: { color: C.muted, fontSize: 14, lineHeight: 20, textAlign: "center" },
	empty: { flexGrow: 1, justifyContent: "center", alignItems: "center", gap: 12, padding: 24 },
	suggestions: { gap: 8, alignSelf: "stretch", maxWidth: 420, width: "100%" },
	suggestion: {
		borderColor: C.line,
		borderWidth: StyleSheet.hairlineWidth,
		borderRadius: 10,
		paddingHorizontal: 12,
		paddingVertical: 10,
	},
	suggestionText: { color: C.ink, fontSize: 14 },
	gap: { gap: 8 },
	gapRow: { gap: 8 },
	flex: { flex: 1 },
	chip: {
		flexDirection: "row",
		alignItems: "center",
		gap: 5,
		maxWidth: 220,
		paddingHorizontal: 7,
		paddingVertical: 3,
		borderRadius: 6,
		backgroundColor: C.sunken,
	},
	chipText: { color: C.ink, fontSize: 12, fontWeight: "600", flexShrink: 1 },
	chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6, marginLeft: 21 },
	tools: { paddingVertical: 2 },
	toolsHead: { flexDirection: "row", alignItems: "center", gap: 8 },
	toolsText: { flex: 1, color: C.muted, fontSize: 13 },
	step: { marginLeft: 21, marginTop: 6, gap: 2 },
	stepLabel: { color: C.ink, fontSize: 12.5 },
	stepResult: { color: C.faint, fontSize: 12 },
	card: {
		backgroundColor: C.surface,
		borderColor: C.line,
		borderWidth: StyleSheet.hairlineWidth,
		borderRadius: 12,
		padding: 12,
		gap: 8,
	},
	cardWaiting: { borderColor: C.amber },
	cardHead: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
	cardTitle: { color: C.ink, fontSize: 13, fontWeight: "700" },
	cardMeta: { color: C.muted, fontSize: 12 },
	cardBody: { color: C.ink, fontSize: 14, lineHeight: 19 },
	cardActions: { flexDirection: "row", gap: 16 },
	clipped: { maxHeight: 220, overflow: "hidden" },
	action: { color: C.ink, fontSize: 13, fontWeight: "600" },
	proposalName: { color: C.ink, fontSize: 15, fontWeight: "700" },
	prompt: {
		color: C.ink,
		fontSize: 13,
		lineHeight: 18,
		backgroundColor: C.sunken,
		borderRadius: 8,
		padding: 10,
	},
	buttons: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
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
	replyRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
	replyInput: {
		flex: 1,
		color: C.ink,
		fontSize: 15,
		backgroundColor: C.sunken,
		borderRadius: 8,
		paddingHorizontal: 10,
		paddingVertical: 8,
		maxHeight: 120,
	},
	sendSmall: {
		width: 32,
		height: 32,
		borderRadius: 16,
		backgroundColor: C.ink,
		alignItems: "center",
		justifyContent: "center",
	},
	userWrap: { alignItems: "flex-end", gap: 6 },
	userTo: { flexDirection: "row", alignItems: "center", gap: 6 },
	user: {
		maxWidth: "85%",
		backgroundColor: C.sunken,
		borderRadius: 14,
		paddingHorizontal: 12,
		paddingVertical: 8,
	},
	userText: { color: C.ink, fontSize: 15, lineHeight: 21 },
	files: { flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" },
	thumb: { width: 64, height: 64, borderRadius: 8, backgroundColor: C.sunken },
	fileChip: {
		flexDirection: "row",
		alignItems: "center",
		gap: 5,
		maxWidth: 200,
		paddingHorizontal: 8,
		paddingVertical: 5,
		borderRadius: 6,
		backgroundColor: C.sunken,
	},
	fileName: { color: C.ink, fontSize: 12, flexShrink: 1 },
	inlineRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
	notice: { color: C.muted, fontSize: 13 },
	errorText: { color: C.red, fontSize: 13 },
	waiting: {
		borderTopWidth: StyleSheet.hairlineWidth,
		borderColor: C.line,
		backgroundColor: C.surface,
		paddingHorizontal: 12,
		paddingVertical: 8,
	},
	waitingHead: { flexDirection: "row", alignItems: "center", gap: 8 },
	waitingDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.amber },
	waitingTitle: { color: C.ink, fontSize: 13, fontWeight: "700" },
	waitingLine: { flex: 1, color: C.muted, fontSize: 13 },
	waitingList: { maxHeight: 380, marginTop: 8 },
	composer: {
		paddingHorizontal: 12,
		paddingTop: 6,
		paddingBottom: 10,
		width: "100%",
		maxWidth: CONTENT_MAX,
		alignSelf: "center",
		gap: 6,
	},
	note: { paddingHorizontal: 4 },
	pending: { flexGrow: 0 },
	unattach: {
		position: "absolute",
		top: -4,
		right: -4,
		width: 18,
		height: 18,
		borderRadius: 9,
		backgroundColor: C.ink,
		alignItems: "center",
		justifyContent: "center",
	},
	box: {
		flexDirection: "row",
		alignItems: "flex-end",
		gap: 6,
		backgroundColor: C.surface,
		borderColor: C.line,
		borderWidth: StyleSheet.hairlineWidth,
		borderRadius: 20,
		paddingHorizontal: 6,
		paddingVertical: 5,
	},
	boxIcon: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
	input: {
		flex: 1,
		color: C.ink,
		fontSize: 16,
		maxHeight: 130,
		paddingTop: 7,
		paddingBottom: 7,
	},
	sendBtn: {
		width: 32,
		height: 32,
		borderRadius: 16,
		backgroundColor: C.ink,
		alignItems: "center",
		justifyContent: "center",
	},
});
