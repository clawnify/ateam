// The Lead chat: one conversation with a coordinator agent that starts, steers
// and reads every task on every engine (main/lead). Native rendering, not a
// terminal: the user's messages, the Lead's prose, and its board moves folded
// into one line each, with the tasks it touched as chips that open the task.
import {
	applyLeadEvent,
	findLeadTask,
	type LeadAttachResult,
	type LeadFile,
	type LeadHome,
	type LeadItem,
	type LeadPermissionAnswer,
	type LeadSnapshot,
	type LeadTaskRef,
	type LeadThread,
	type LeadThreadEntry,
	type LeadToolItem,
	leadToolResult,
	leadToolStep,
	leadToolTask,
	type ProjectDTO,
	summarizeLeadTools,
	type TaskDTO,
	toLeadBlocks,
} from "@ateam/protocol";
import {
	ArrowDown,
	ArrowUp,
	ChevronLeft,
	ChevronRight,
	CircleHelp,
	CornerDownRight,
	Maximize2,
	Paperclip,
	Plus,
	Smile,
	Square,
	SquarePen,
	X,
	Zap,
} from "lucide-react";
import {
	type ClipboardEvent,
	type FormEvent,
	Fragment,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { flushSync } from "react-dom";
import {
	arrived,
	FOLLOWING,
	firstLine,
	goTo,
	landed,
	openFrom,
	type StackView,
	shown,
	unseen,
} from "../lead-blocks";
import { type DraftRef, expandRefs, splitSent } from "../lead-refs";
import { recordEmoji, topEmoji } from "../lib/emoji-use";
import { taskDragProps } from "../task-drag";
import { AgentIcon } from "./AgentIcon";
import { IconButton } from "./IconButton";
import { Markdown, TaskLinkContext } from "./Markdown";
import { PageFrame } from "./PageFrame";
import { PanelRightFilled } from "./PanelRightFilled";
import { ProposalStrip } from "./Proposals";
import { QuestionCard } from "./QuestionCard";
import { ReplyField } from "./ReplyField";
import { TaskRefInput } from "./TaskRefInput";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
	EmojiPicker,
	EmojiPickerContent,
	EmojiPickerFooter,
	EmojiPickerSearch,
} from "./ui/emoji-picker";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

const EMPTY: LeadSnapshot = { items: [], draft: "", busy: false, auto: false };

/** How many of the latest items the chat loads; "Show earlier" pages back. */
const PAGE = 200;

const SUGGESTIONS = [
	"What should I focus on in the next hour?",
	"Which tasks need me?",
	"What did the last finished task say?",
];

function ToolGroup({
	tools,
	tasks,
	onOpenTask,
}: {
	tools: LeadToolItem[];
	tasks: TaskDTO[];
	onOpenTask: (t: TaskDTO) => void;
}) {
	const [open, setOpen] = useState(false);
	const running = tools.some((t) => t.result === undefined);
	const failed = tools.filter((t) => t.isError).length;
	// Starting and messaging a task are what the user came for: those tasks stay
	// visible as chips even while the steps that touched them are folded away.
	const touched = tools
		.filter(
			(t) => (t.name === "create_task" || t.name === "send_message") && t.result && !t.isError,
		)
		.map((t) => ({ tool: t, task: leadToolTask(t, tasks) }))
		.filter((x): x is { tool: LeadToolItem; task: TaskDTO } => x.task != null);
	return (
		<div className="lead-tools">
			<button
				type="button"
				className="lead-tools-head"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
			>
				<span className={running ? "lead-tools-sum shimmer" : "lead-tools-sum"}>
					{summarizeLeadTools(tools, tasks)}
				</span>
				{failed > 0 && <span className="lead-tools-failed">Failed</span>}
				<ChevronRight size={12} className={open ? "lead-chev open" : "lead-chev"} />
			</button>
			{open && (
				<div className="lead-steps">
					{tools.map((t) => (
						<ToolStep
							key={t.id}
							tool={t}
							label={leadToolStep(t, tasks)}
							solo={tools.length === 1}
						/>
					))}
				</div>
			)}
			{touched.length > 0 && (
				<div className="lead-chips">
					{touched.map(({ tool, task }) => (
						<button
							type="button"
							key={tool.id}
							className="lead-chip"
							title={`Open ${task.name}`}
							onClick={() => onOpenTask(task)}
							{...taskDragProps(task.id)}
						>
							<AgentIcon agentId={task.agentId} size={12} />
							<span className="lead-chip-name">{task.name}</span>
							<span className="lead-chip-what">
								{tool.name === "create_task" ? "started" : "sent"}
							</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/** One step in an opened group: what it did and how it ended; its raw input
 *  and result open below on a click, for when the summary isn't enough. */
function ToolStep({ tool, label, solo }: { tool: LeadToolItem; label: string; solo: boolean }) {
	// A group of one has nothing to summarize twice: its detail is what was asked for.
	const [open, setOpen] = useState(solo);
	const running = tool.result === undefined;
	return (
		<div className={tool.isError ? "lead-step error" : "lead-step"}>
			<button type="button" className="lead-step-row" onClick={() => setOpen((o) => !o)}>
				<span className={running ? "lead-step-label shimmer" : "lead-step-label"}>{label}</span>
				{tool.isError ? (
					<span className="lead-tools-failed">Failed</span>
				) : (
					!running && <span className="lead-step-result">{leadToolResult(tool)}</span>
				)}
			</button>
			{open && (
				<div className="lead-step-detail">
					{Object.keys(tool.input).length > 0 && (
						<pre className="lead-tool-io">{JSON.stringify(tool.input, null, 2)}</pre>
					)}
					{!running && <pre className="lead-tool-io">{tool.result}</pre>}
				</div>
			)}
		</div>
	);
}

/** An IPC rejection carries Electron's prefix before the engine's own words. */
const cleanError = (e: unknown) =>
	(e instanceof Error ? e.message : String(e)).replace(
		/^Error invoking remote method '[^']+': (Error: )?/,
		"",
	);

/** Previews by path, fetched once: an attachment never changes. */
const thumbs = new Map<string, Promise<string | null>>();

function useThumb(file: LeadFile): string | null {
	const [src, setSrc] = useState<string | null>(null);
	useEffect(() => {
		if (!file.image) return;
		let live = true;
		let p = thumbs.get(file.path);
		if (!p) {
			p = window.ateamLead.thumb(file.path).catch(() => null);
			thumbs.set(file.path, p);
		}
		void p.then((s) => live && setSrc(s));
		return () => {
			live = false;
		};
	}, [file.path, file.image]);
	return src;
}

const sizeLabel = (n: number) =>
	n < 1024 * 1024
		? `${Math.max(1, Math.round(n / 1024))} KB`
		: `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;

/** An attached file: a thumbnail for an image, a chip for anything else (or
 *  an image whose copy is gone). */
function Attachment({ file, onRemove }: { file: LeadFile; onRemove?: () => void }) {
	const src = useThumb(file);
	const remove = onRemove && (
		<button
			type="button"
			className="fc-x"
			aria-label={`Remove ${file.name}`}
			title="Remove"
			onClick={onRemove}
		>
			<X size={12} strokeWidth={2.25} />
		</button>
	);
	if (src)
		return (
			<span className="lead-thumb" title={file.name}>
				<img src={src} alt={file.name} />
				{remove}
			</span>
		);
	return (
		<span className="file-chip" title={file.path}>
			<span className="fc-name">{file.name}</span>
			<span className="lead-file-size">{sizeLabel(file.size)}</span>
			{remove}
		</span>
	);
}

/** A task named in the thread; opens it when it is on a board this window has
 *  loaded. Every task chip also drags onto Mission Control (task-drag.ts). */
function TaskChip({
	task,
	tasks,
	onOpenTask,
}: {
	task: LeadTaskRef;
	tasks: TaskDTO[];
	onOpenTask: (t: TaskDTO) => void;
}) {
	const loaded = tasks.find((t) => t.id === task.taskId);
	return (
		<button
			type="button"
			className="lead-chip"
			title={loaded ? `Open ${task.name}` : task.name}
			disabled={!loaded}
			onClick={() => loaded && onOpenTask(loaded)}
			{...taskDragProps(loaded?.id)}
		>
			<AgentIcon agentId={task.agentId} size={12} />
			<span className="lead-chip-name">{task.name}</span>
		</button>
	);
}

/** A task the Lead named in its prose, `[fix login](task:<id>)`: a chip that
 *  opens it, in the Lead's own words. Those are often clearer than the task's
 *  name, which is usually the first words of its prompt ("In our website in
 *  Clawnify org"), so the name goes in the tooltip. One this window can't find
 *  (deleted, or on a box that isn't connected) is greyed. */
function TaskLink({
	target,
	label,
	tasks,
	onOpenTask,
}: {
	target: string;
	label: ReactNode;
	tasks: TaskDTO[];
	onOpenTask: (t: TaskDTO) => void;
}) {
	const task = findLeadTask(tasks, target);
	return (
		<button
			type="button"
			className="lead-chip"
			title={task ? `Open ${task.name}` : "Not on a board this window has loaded"}
			disabled={!task}
			onClick={() => task && onOpenTask(task)}
			{...taskDragProps(task?.id)}
		>
			{task && <AgentIcon agentId={task.agentId} size={12} />}
			<span className="lead-chip-name">{label}</span>
		</button>
	);
}

/** The user's own words as sent: plain text, with the tasks they picked by
 *  typing "@" (sent as task links, lead-refs.ts) drawn as chips. */
function SentText({
	text,
	renderTaskLink,
}: {
	text: string;
	renderTaskLink: (target: string, label: ReactNode) => ReactNode;
}) {
	let links = 0;
	return splitSent(text).map((p) =>
		"text" in p ? p.text : <Fragment key={links++}>{renderTaskLink(p.target, p.label)}</Fragment>,
	);
}

const OUTCOME: Record<LeadPermissionAnswer | "cancelled", string> = {
	allow: "Allowed",
	always: "Allowed, and won't ask again",
	deny: "Denied",
	cancelled: "No longer waiting",
};

/** The Lead's agent asks before using a tool: answered here, since nobody
 *  watches its terminal. Answered or not, it stays in the thread as a record. */
function LeadPermission({ item }: { item: Extract<LeadItem, { kind: "permission" }> }) {
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const decide = async (answer: LeadPermissionAnswer) => {
		setSending(true);
		setError(null);
		try {
			await window.ateamLead.permission(item.id, answer);
		} catch (e) {
			setError(cleanError(e));
		} finally {
			setSending(false);
		}
	};
	return (
		<section className="question" aria-label="The Lead asks for permission">
			<div className="question-head">
				<CircleHelp size={13} className="question-icon" />
				<span className="question-who">The Lead asks</span>
				<span className="question-kind">permission</span>
			</div>
			<div className="md question-text">
				<Markdown text={item.text} />
			</div>
			{item.answer ? (
				<div className="lead-permission-outcome">
					{item.answer === "always" && item.always
						? `Allowed, and won't ask again for ${item.always}`
						: OUTCOME[item.answer]}
				</div>
			) : (
				<div className="question-options">
					<button
						type="button"
						className="primary"
						disabled={sending}
						onClick={() => void decide("allow")}
					>
						Allow
					</button>
					{item.canAlways && (
						<button
							type="button"
							disabled={sending}
							title={
								item.always
									? `Don't ask again in the Lead for ${item.always}`
									: "Don't ask again in the Lead"
							}
							onClick={() => void decide("always")}
						>
							Always allow
						</button>
					)}
					<button type="button" disabled={sending} onClick={() => void decide("deny")}>
						Deny
					</button>
				</div>
			)}
			{error && <p className="question-error">{error}</p>}
		</section>
	);
}

/** Answering a reply with an emoji, picked from the full set: the emoji is the
 *  whole answer, sent as soon as it is picked. Once sent it stands in for the
 *  icon, and picking another sends that one in its place. */
function EmojiReply({
	name,
	reaction,
	disabled,
	onPick,
}: {
	name: string;
	/** The emoji the reply was answered with, if it was. */
	reaction?: string;
	disabled: boolean;
	/** Sends it; true once it went. */
	onPick: (emoji: string) => Promise<boolean>;
}) {
	const [open, setOpen] = useState(false);
	/** Past the quick row, into the full picker (its last button, +). */
	const [more, setMore] = useState(false);
	// The quick row is the emoji sent before; with none yet, the full picker.
	const top = open ? topEmoji() : [];
	const full = more || top.length === 0;
	const pick = async (emoji: string) => {
		setOpen(false);
		if (await onPick(emoji)) recordEmoji(emoji);
	};
	return (
		<Popover
			open={open}
			onOpenChange={(o) => {
				setOpen(o);
				if (!o) setMore(false);
			}}
		>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="icon-xs"
					className={reaction ? "text-[15px]" : undefined}
					disabled={disabled}
					title={reaction ? `You answered ${reaction}` : "Reply with an emoji"}
					aria-label={
						reaction
							? `You answered ${name} with ${reaction}, answer with another emoji`
							: `Reply to ${name} with an emoji`
					}
				>
					{reaction ?? <Smile className="size-3.5" strokeWidth={1.75} />}
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" collisionPadding={8} className="w-fit p-0">
				{full ? (
					<EmojiPicker className="h-[342px]" onEmojiSelect={({ emoji }) => void pick(emoji)}>
						<EmojiPickerSearch autoFocus />
						<EmojiPickerContent />
						<EmojiPickerFooter />
					</EmojiPicker>
				) : (
					<div className="flex items-center gap-0.5 p-1">
						{top.map((emoji) => (
							<Button
								key={emoji}
								variant="ghost"
								size="icon-sm"
								className="text-lg"
								title={`Reply with ${emoji}`}
								onClick={() => void pick(emoji)}
							>
								{emoji}
							</Button>
						))}
						<Button
							variant="ghost"
							size="icon-sm"
							title="More emoji"
							aria-label="More emoji"
							onClick={() => setMore(true)}
						>
							<Plus strokeWidth={1.75} />
						</Button>
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}

export type LeadProposalItem = Extract<LeadItem, { kind: "proposal" }>;

/** A task or loop the Lead proposed. While it waits, the same strip a task's
 *  proposals get: open its dialog, or dismiss it. Then what became of it. */
function LeadProposalCard({
	item,
	tasks,
	onOpen,
	onOpenTask,
}: {
	item: LeadProposalItem;
	tasks: TaskDTO[];
	onOpen: (item: LeadProposalItem) => void;
	onOpenTask: (t: TaskDTO) => void;
}) {
	const [error, setError] = useState<string | null>(null);
	const { kind, name } = item.proposal;
	if (!item.outcome)
		return (
			<div>
				<ProposalStrip
					label="Proposed by the Lead"
					proposals={[{ ...item.proposal, id: item.id, proposedAt: item.at }]}
					onOpen={() => onOpen(item)}
					onDismiss={() =>
						void window.ateamLead
							.proposal(item.id, "dismissed")
							.catch((e) => setError(cleanError(e)))
					}
				/>
				{error && <p className="question-error">{error}</p>}
			</div>
		);
	const what = kind === "loop" ? "loop" : "task";
	return (
		<div className="lead-notice info">
			{item.outcome === "created"
				? item.task
					? "Created"
					: `Created the ${what} ${name}`
				: item.outcome === "dismissed"
					? `Dismissed the proposed ${what} ${name}`
					: `Replaced by a newer proposal: ${name}`}
			{item.task && <TaskChip task={item.task} tasks={tasks} onOpenTask={onOpenTask} />}
		</div>
	);
}

/** Hours and minutes, on a folded entry. */
const clock = (at: number) =>
	new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** An entry folded to a line, in words: a reply's first line, a page's title. */
function entryLine(e: LeadThreadEntry): string {
	if (e.kind === "agent") return firstLine(e.text);
	if (e.kind === "page") return `Made a page, "${e.title}"`;
	return e.text;
}

/** A thread entry the user can open to read: a reply or a page. */
type Openable = Extract<LeadThreadEntry, { kind: "agent" | "page" }>;
const isOpenable = (e: LeadThreadEntry): e is Openable => e.kind === "agent" || e.kind === "page";

/** What the card's head says the task did, from its latest entry of its own. */
function threadVerb(t: LeadThread): string {
	const own = t.entries.findLast((e) => e.kind === "agent" || e.kind === "page");
	return own?.kind === "page" ? "made a page" : own ? "replied" : "";
}

/** A followed task talking back, as a thread: its replies, the user's answers
 *  to it, its pages and notices, in order. Once there is more than one reply,
 *  every entry is a line in a list that scrolls, and one reply or page is open
 *  below it: the latest, or the line the user picked (one at a time, like a
 *  mail client). The open one keeps the height of the tallest reply read in
 *  the thread, so the card doesn't jump as the user picks. One box answers it,
 *  in words or with an emoji (on the last reply). The card and its
 *  head are the stack's (ThreadStack). Expanded, the whole thread opens in a
 *  dialog with the same answer box, so a half-typed answer is in both. */
function ThreadView({
	thread,
	hidden,
	chip,
	expanded,
	onExpandedChange,
	onCut,
	atBottom,
	onContinue,
	canReact,
}: {
	thread: LeadThread;
	/** Another thread of its stack is shown. Kept mounted, so a half-typed answer survives. */
	hidden: boolean;
	/** The task's chip, for the dialog's head. */
	chip: ReactNode;
	/** Shown whole in a dialog. */
	expanded: boolean;
	onExpandedChange: (expanded: boolean) => void;
	/** Whether the card's height cap cuts the open reply off, so expanding shows more. */
	onCut: (key: string, cut: boolean) => void;
	/** Whether the user is following the bottom of the chat. */
	atBottom: () => boolean;
	/** Go to the card further down where this thread goes on. */
	onContinue: (block: string, key: string) => void;
	/** The Lead takes emoji answers (a box before v28 doesn't). */
	canReact: boolean;
}) {
	const { entries, earlier, task } = thread;
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showEarlier, setShowEarlier] = useState(false);
	/** The reply or page the user picked to read, by id; null reads the latest. */
	const [picked, setPicked] = useState<string | null>(null);
	/** The tallest the open reply has been in this thread, which its area keeps. */
	const [tallest, setTallest] = useState(0);
	const md = useRef<HTMLDivElement>(null);
	const whole = useRef<HTMLDivElement>(null);
	/** What had focus before the dialog took it. */
	const back = useRef<HTMLElement | null>(null);
	const lastReply = entries.findLast((e) => e.kind === "agent");
	const latest = entries.findLast(isOpenable);
	const all = showEarlier ? [...earlier, ...entries] : entries;
	const reading = all.find((e): e is Openable => isOpenable(e) && e.id === picked) ?? latest;
	// One reply and nothing before it reads as it is; anything more is a list.
	const listed = earlier.length > 0 || (latest !== undefined && entries.indexOf(latest) > 0);
	const pick = (id: string) => setPicked(id === latest?.id ? null : id);
	const folds = useRef<HTMLDivElement>(null);
	/** Where the user scrolled the list to, or null while it rests on the newest. */
	const foldsAt = useRef<number | null>(null);

	// The list scrolls in a box of its own, resting on the newest line. A
	// new entry keeps it there, unless the user scrolled up in it. Shown again
	// after another thread of the stack, it comes back to where it was.
	// biome-ignore lint/correctness/useExhaustiveDependencies: entries.length is the trigger, not a value the body reads: an entry adds a line.
	useLayoutEffect(() => {
		const el = folds.current;
		if (el && !hidden) el.scrollTop = foldsAt.current ?? el.scrollHeight;
	}, [hidden, entries.length]);

	// A new reply takes the place of the one open. Scrolled up reading that
	// one, the user keeps it open instead, so the text doesn't change under them.
	const [count, setCount] = useState(entries.length);
	if (count !== entries.length) {
		setCount(entries.length);
		const was = entries.slice(0, count).findLast(isOpenable);
		if (entries.length > count && picked === null && was && was !== latest && !atBottom())
			setPicked(was.id);
	}

	// The open reply's box changes size whenever it starts or stops being cut
	// off: under the cap it is the reply's height, over it the cap's. So
	// watching its size is enough. A hidden thread keeps what it last reported.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reading is the trigger, not a value the body reads: opening another reply puts a new box in md.
	useEffect(() => {
		const el = md.current;
		if (!el || hidden) {
			if (!el) onCut(thread.key, false);
			return;
		}
		const watch = new ResizeObserver(() => {
			onCut(thread.key, el.scrollHeight > el.clientHeight + 1);
			setTallest((t) => Math.max(t, el.offsetHeight));
		});
		watch.observe(el);
		return () => watch.disconnect();
	}, [hidden, thread.key, onCut, reading?.id]);

	const send = async (go: () => Promise<void>) => {
		setSending(true);
		setError(null);
		try {
			await go();
			onExpandedChange(false);
			return true;
		} catch (err) {
			setError(cleanError(err));
			return false;
		} finally {
			setSending(false);
		}
	};
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (!text.trim()) return;
		if (await send(() => window.ateamLead.reply(task.taskId, text))) {
			setText("");
			setOpen(false);
		}
	};

	/** An entry as the list shows it: a reply or a page as a line that opens it
	 *  below (marked while it is), what the user sent folded, a notice as it is. */
	const line = (e: LeadThreadEntry) => {
		if (e.kind === "user") return <YouSaid key={e.id} entry={e} folded />;
		if (e.kind === "notice")
			return (
				<p key={e.id} className="lead-notice info">
					{e.text}
				</p>
			);
		const reaction = e.kind === "agent" ? e.reaction : undefined;
		return (
			<button
				key={e.id}
				type="button"
				className="lead-fold"
				aria-current={e === reading || undefined}
				onClick={() => pick(e.id)}
			>
				<span className="lead-fold-dot" />
				<span className="lead-fold-line">{entryLine(e)}</span>
				{reaction && <span className="lead-fold-react">{reaction}</span>}
				<span className="lead-fold-at">{clock(e.at)}</span>
			</button>
		);
	};
	/** An entry open; the reply being read is capped and scrolls past the cap. */
	const full = (e: LeadThreadEntry) => {
		if (e.kind === "user") return <YouSaid key={e.id} entry={e} />;
		if (e.kind === "notice")
			return (
				<p key={e.id} className="lead-notice info">
					{e.text}
				</p>
			);
		if (e.kind === "page")
			return <PageFrame key={e.id} taskId={e.task.taskId} pageId={e.pageId} title={e.title} />;
		const cap = e === reading;
		return (
			<div key={e.id} ref={cap ? md : undefined} className={cap ? "md lead-reply-capped" : "md"}>
				<Markdown text={e.text} />
			</div>
		);
	};

	// Drawn twice, in the card and in the dialog, from the one draft. Once the
	// thread goes on further down, its answer box is there; this one says so.
	const answer =
		thread.continuedIn && !open ? (
			<div className="lead-agent-actions">
				<button
					type="button"
					className="lead-agent-reply"
					onClick={() => {
						onExpandedChange(false);
						if (thread.continuedIn) onContinue(thread.continuedIn, thread.key);
					}}
				>
					<ArrowDown size={12} />
					Continues below
				</button>
			</div>
		) : (
			<>
				<div className="lead-agent-actions">
					{open ? (
						<form className="question-reply" onSubmit={submit}>
							<ReplyField
								autoFocus
								value={text}
								placeholder={`Reply to ${task.name}`}
								aria-label={`Reply to ${task.name}`}
								disabled={sending}
								onChange={(e) => setText(e.target.value)}
								onEscape={() => setOpen(false)}
							/>
							<button type="submit" disabled={sending || !text.trim()}>
								Send
							</button>
						</form>
					) : (
						<>
							<button type="button" className="lead-agent-reply" onClick={() => setOpen(true)}>
								<CornerDownRight size={12} />
								Reply
							</button>
							{lastReply && canReact && (
								<EmojiReply
									name={task.name}
									reaction={lastReply.reaction}
									disabled={sending}
									onPick={(emoji) => send(() => window.ateamLead.react(lastReply.id, emoji))}
								/>
							)}
						</>
					)}
				</div>
				{error && <p className="question-error">{error}</p>}
			</>
		);
	return (
		<div className="lead-agent-body" hidden={hidden}>
			<div className="lead-thread-entries">
				{listed ? (
					<>
						<div
							ref={folds}
							className="lead-thread-folds"
							onScroll={(e) => {
								const el = e.currentTarget;
								const end = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
								foldsAt.current = end ? null : el.scrollTop;
							}}
						>
							{earlier.length > 0 && (
								<button
									type="button"
									className="lead-fold lead-earlier"
									aria-expanded={showEarlier}
									onClick={() => setShowEarlier((s) => !s)}
								>
									<span className="lead-fold-dot" />
									<span className="lead-fold-line">
										{showEarlier ? "Hide earlier" : `${earlier.length} earlier in this thread`}
									</span>
								</button>
							)}
							{all.map(line)}
						</div>
						{reading && (
							<>
								<div className="lead-thread-sep" />
								<div
									className="lead-thread-read"
									style={{ minHeight: `min(${tallest}px, var(--lead-reply-cap))` }}
								>
									{full(reading)}
								</div>
							</>
						)}
					</>
				) : (
					entries.map(full)
				)}
			</div>
			{answer}
			<Dialog open={expanded} onOpenChange={onExpandedChange}>
				{/* The thread's reading column and prose size; as tall as the thread
				    needs, up to the window, where it scrolls. */}
				<DialogContent
					className="flex max-h-[calc(100vh-4rem)] flex-col gap-3 p-5 text-[14px] leading-normal sm:max-w-[776px]"
					aria-describedby={undefined}
					// Focus the thread, so the arrow and page keys scroll it.
					onOpenAutoFocus={(e) => {
						e.preventDefault();
						back.current = document.activeElement as HTMLElement | null;
						whole.current?.focus({ preventScroll: true });
						// The newest is what the user came for.
						if (whole.current) whole.current.scrollTop = whole.current.scrollHeight;
					}}
					// Radix hands focus back to a Dialog.Trigger, and this dialog has
					// none (Expand sits in the stack's head), so focus would drop to
					// the page. Back to what had it, Expand when that opened it.
					onCloseAutoFocus={(e) => {
						e.preventDefault();
						if (back.current?.isConnected) back.current.focus({ preventScroll: true });
					}}
				>
					<DialogTitle className="lead-agent-head pr-8 text-sm leading-normal font-normal">
						{chip}
						<span className="lead-agent-said">{threadVerb(thread)}</span>
					</DialogTitle>
					<div ref={whole} className="lead-reply-whole lead-thread-entries" tabIndex={-1}>
						{[...earlier, ...entries].map((e) => (
							<ThreadWhole key={e.id} entry={e} />
						))}
					</div>
					{answer}
				</DialogContent>
			</Dialog>
		</div>
	);
}

/** The user's words in a thread, under the question they answer when they
 *  answered one: the question card is gone by then, so this is its record. */
function YouSaid({
	entry: e,
	folded = false,
}: {
	entry: Extract<LeadThreadEntry, { kind: "user" }>;
	folded?: boolean;
}) {
	const words = <div className={folded ? "lead-you folded" : "lead-you"}>{e.text}</div>;
	if (!e.question) return words;
	return (
		<div className="lead-you-answer">
			<div className="lead-you-question" title={e.question}>
				<CircleHelp size={11} aria-hidden />
				<span>{firstLine(e.question)}</span>
			</div>
			{words}
		</div>
	);
}

/** An entry in the whole thread (the Expand dialog): every one open. */
function ThreadWhole({ entry: e }: { entry: LeadThreadEntry }) {
	if (e.kind === "user") return <YouSaid entry={e} />;
	if (e.kind === "notice") return <p className="lead-notice info">{e.text}</p>;
	if (e.kind === "page")
		return <PageFrame taskId={e.task.taskId} pageId={e.pageId} title={e.title} />;
	return (
		<div className="lead-whole-reply">
			<div className="md">
				<Markdown text={e.text} />
			</div>
			{e.reaction && <span className="lead-fold-react">{e.reaction}</span>}
		</div>
	);
}

/** Tasks that talked one after another: one card showing one task's thread at
 *  a time, the one that spoke last first (the rules are in lead-blocks.ts).
 *  The arrows and ←/→ step through the tasks, and the "2 of 5" count lists
 *  them all to jump to one. The head stays mounted while the thread below it
 *  changes, so a focused arrow keeps focus and the next press goes on stepping. */
function ThreadStack({
	id,
	threads,
	total,
	tasks,
	onOpenTask,
	atBottom,
	onPaged,
	jump,
	onContinue,
	canReact,
}: {
	/** The block's id, which "Continues below" in an earlier card points to. */
	id: string;
	/** Newest talker last. */
	threads: LeadThread[];
	/** How many entries the stack's tasks have sent, across its threads (`landed`). */
	total: number;
	tasks: TaskDTO[];
	onOpenTask: (t: TaskDTO) => void;
	/** Whether the user is following the bottom of the chat. */
	atBottom: () => boolean;
	/** The user switched threads: the card, to keep its top in view. */
	onPaged: (card: HTMLElement) => void;
	/** "Continues below" was clicked for a thread in this stack: show it. */
	jump: { block: string; key: string; n: number } | null;
	onContinue: (block: string, key: string) => void;
	/** The Lead takes emoji answers (a box before v28 doesn't). */
	canReact: boolean;
}) {
	const keys = threads.map((t) => t.key);
	const n = keys.length;
	const [view, setView] = useState<StackView>(FOLLOWING);
	const [prev, setPrev] = useState({ keys, total });
	if (prev.total !== total) {
		setPrev({ keys, total });
		setView((v) => arrived(v, prev.keys, prev.total, total, atBottom()));
	}
	const cur = shown(view, keys);
	const card = useRef<HTMLDivElement>(null);
	const countBtn = useRef<HTMLButtonElement>(null);
	/** The thread open whole in a dialog, by key. */
	const [expanded, setExpanded] = useState<string | null>(null);
	/** Which threads' open reply the card's height cap cuts off (ThreadView measures). */
	const [cut, setCut] = useState<Record<string, boolean>>({});
	const onCut = useCallback(
		(key: string, c: boolean) => setCut((m) => (m[key] === c ? m : { ...m, [key]: c })),
		[],
	);
	const jumped = useRef(0);
	useEffect(() => {
		if (!jump || jump.block !== id || jump.n === jumped.current) return;
		jumped.current = jump.n;
		const i = keys.indexOf(jump.key);
		if (i >= 0) setView((v) => goTo(v, i, keys, total));
	}, [jump, id, keys, total]);
	const go = (i: number) => {
		if (i === cur || i < 0 || i >= n) return;
		const focused = card.current?.contains(document.activeElement);
		// Committed now, so the card is measured showing the thread it switched to.
		flushSync(() => setView((v) => goTo(v, i, keys, total)));
		// At the first or last thread the arrow that stepped there disables
		// itself and drops focus; the count takes it, so ←/→ go on working.
		const a = document.activeElement as HTMLButtonElement | null;
		if (focused && (a?.disabled || !card.current?.contains(a)))
			countBtn.current?.focus({ preventScroll: true });
		if (card.current) onPaged(card.current);
	};
	const thread = threads[cur];
	const prevT = threads[cur - 1];
	const nextT = threads[cur + 1];
	const fresh = unseen(view, keys, total);
	if (!thread) return null;
	const replies = (t: LeadThread) => t.entries.filter((e) => e.kind === "agent").length;
	const nav = n > 1 && (
		<div className="lead-stack-nav">
			<IconButton
				icon={ChevronLeft}
				size={14}
				label={prevT ? `Previous: ${prevT.task.name}` : "Previous"}
				disabled={!prevT}
				onClick={() => go(cur - 1)}
			/>
			<DropdownMenu modal={false}>
				<DropdownMenuTrigger asChild>
					<Button
						ref={countBtn}
						variant="ghost"
						size="xs"
						className="tabular-nums"
						title="All tasks that replied"
						aria-label={`Task ${cur + 1} of ${n}, list all`}
					>
						{cur + 1} of {n}
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" collisionPadding={8} className="w-[320px]">
					<DropdownMenuRadioGroup value={String(cur)} onValueChange={(v) => go(Number(v))}>
						{threads.map((t, i) => {
							const last = t.entries[t.entries.length - 1];
							const r = replies(t);
							return (
								<DropdownMenuRadioItem key={t.key} value={String(i)}>
									<AgentIcon agentId={t.task.agentId} size={12} />
									<span className="flex min-w-0 flex-col">
										<span className="truncate">
											{t.task.name}
											{r > 1 && <span className="text-muted-foreground"> · {r} replies</span>}
										</span>
										<span className="truncate text-xs text-muted-foreground">
											{last ? entryLine(last) : ""}
										</span>
									</span>
								</DropdownMenuRadioItem>
							);
						})}
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
			<span className="lead-stack-next">
				<IconButton
					icon={ChevronRight}
					size={14}
					label={nextT ? `Next: ${nextT.task.name}${fresh ? " (new)" : ""}` : "Next"}
					disabled={!nextT}
					onClick={() => go(cur + 1)}
				/>
				{fresh && <span className="lead-stack-dot" />}
			</span>
		</div>
	);
	// Expand shows more than the card does: a reply the cap cuts, or entries
	// folded above it.
	const more =
		cut[thread.key] || thread.earlier.length > 0 || openFrom(thread.entries.map((e) => e.kind)) > 0;
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: ←/→ step through the threads from anywhere in the card, not from one control
		<div
			ref={card}
			className="lead-agent"
			data-block={id}
			onKeyDown={(e) => {
				// Not while typing an answer, and not from the list (a portal, outside the card).
				const t = e.target as HTMLElement;
				if (n < 2 || t.closest("input, textarea") || !e.currentTarget.contains(t)) return;
				if (e.key === "ArrowLeft" && prevT) go(cur - 1);
				else if (e.key === "ArrowRight" && nextT) go(cur + 1);
				else return;
				e.preventDefault();
			}}
		>
			<div className="lead-agent-head">
				<TaskChip task={thread.task} tasks={tasks} onOpenTask={onOpenTask} />
				<span className="lead-agent-said">{threadVerb(thread)}</span>
				<div className="lead-agent-tools">
					{more && (
						<IconButton
							icon={Maximize2}
							size={13}
							label="Expand"
							onClick={() => setExpanded(thread.key)}
						/>
					)}
					{nav}
				</div>
			</div>
			{threads.map((t, i) => (
				<ThreadView
					key={t.key}
					thread={t}
					hidden={i !== cur}
					atBottom={atBottom}
					onContinue={onContinue}
					canReact={canReact}
					chip={
						<TaskChip
							task={t.task}
							tasks={tasks}
							onOpenTask={(task) => {
								setExpanded(null);
								onOpenTask(task);
							}}
						/>
					}
					expanded={expanded === t.key}
					onExpandedChange={(open) => setExpanded(open ? t.key : null)}
					onCut={onCut}
				/>
			))}
		</div>
	);
}

function Thinking() {
	const [start] = useState(() => Date.now());
	const [, tick] = useState(0);
	useEffect(() => {
		const t = setInterval(() => tick((n) => n + 1), 1000);
		return () => clearInterval(t);
	}, []);
	const secs = Math.floor((Date.now() - start) / 1000);
	return (
		<div className="lead-thinking">
			<span className="shimmer">Working{secs > 0 ? ` for ${secs}s` : "…"}</span>
		</div>
	);
}

/** What the user has typed and not sent. Outlives the component, because the
 *  chat moves between the Lead tab and the sidebar by unmounting one and
 *  mounting the other, and hiding the sidebar unmounts it too. */
let unsent = "";
/** The files attached to that draft, kept the same way. */
let unsentFiles: LeadFile[] = [];
/** The tasks picked into that draft with "@", kept the same way. */
let unsentRefs: DraftRef[] = [];
// Proposals whose dialog already opened by itself: each does once, as it
// arrives while the chat is on screen (kept across the tab and the sidebar).
const autoOpened = new Set<string>();

export function LeadChat({
	tasks,
	projects,
	onOpenTask,
	onOpenProposal,
	onHide,
	scope,
	home,
	onLeadBox,
	onOpenLeadSettings,
}: {
	/** A project window's chat: the name of the project it is about. */
	scope?: string;
	/** Where the chat lives: this Mac, or a box whose own Lead it is (useLeadHome). */
	home: LeadHome;
	/** Whether a task is on the Lead's box: all that a box's Lead can reach. */
	onLeadBox: (t: TaskDTO) => boolean;
	/** Settings → Boxes, where the chat's home is chosen. */
	onOpenLeadSettings?: () => void;
	/** Every loaded task, across projects and machines, to name and open the ones the Lead touches. */
	tasks: TaskDTO[];
	/** To say which project each task is in when the user picks one with "@". */
	projects: ProjectDTO[];
	onOpenTask: (t: TaskDTO) => void;
	/** Open a proposal's New task or New loop dialog; `auto` when it opens by
	 *  itself on arriving, which App skips while another dialog is up. */
	onOpenProposal: (item: LeadProposalItem, auto: boolean) => void;
	/** Set when the chat is the sidebar on the right: its header is then the
	 *  slim strip that hides it, not the Lead tab's title. */
	onHide?: () => void;
}) {
	const [snap, setSnap] = useState<LeadSnapshot>(EMPTY);
	const [text, setTextState] = useState(() => unsent);
	const setText = (value: string) => {
		unsent = value;
		setTextState(value);
	};
	const [refs, setRefsState] = useState<DraftRef[]>(() => unsentRefs);
	const setRefs = (value: DraftRef[]) => {
		unsentRefs = value;
		setRefsState(value);
	};
	const projectName = useMemo(() => {
		const names = new Map(projects.map((p) => [p.id, p.name]));
		return (id: string) => names.get(id);
	}, [projects]);
	// The Lead names tasks as links (its prompt says how); each is drawn as a
	// chip that opens the task.
	const renderTaskLink = useCallback(
		(target: string, label: ReactNode) => (
			<TaskLink target={target} label={label} tasks={tasks} onOpenTask={onOpenTask} />
		),
		[tasks, onOpenTask],
	);
	// Attached to the next message; already copied into the Lead's folder.
	const [files, setFilesState] = useState<LeadFile[]>(() => unsentFiles);
	const setFiles = (update: (cur: LeadFile[]) => LeadFile[]) =>
		setFilesState((cur) => {
			unsentFiles = update(cur);
			return unsentFiles;
		});
	// Why an attach or a send didn't go through, under the composer.
	const [attachNote, setAttachNote] = useState<string | null>(null);
	const [dragging, setDragging] = useState(false);
	const scroller = useRef<HTMLDivElement>(null);
	const thread = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	// Follow the conversation only while the user is at the bottom of it.
	const pinned = useRef(true);

	const openProposal = useRef(onOpenProposal);
	openProposal.current = onOpenProposal;
	// A turn this chat started, until it ends. A Lead on a box also answers
	// the phone, and a proposal from a turn asked there mustn't pop a dialog
	// on this Mac: it waits as its card.
	const ownTurn = useRef(false);

	useEffect(() => {
		const off = window.ateamLead.onEvent((e) => {
			setSnap((s) => applyLeadEvent(s, e));
			if (e.type === "busy" && !e.busy) ownTurn.current = false;
			// A proposal opens its dialog by itself once, as it arrives here; one
			// that arrived while the chat was closed waits as its card.
			if (e.type === "item" && e.item.kind === "proposal" && !e.item.outcome) {
				if (autoOpened.has(e.item.id) || !ownTurn.current) return;
				autoOpened.add(e.item.id);
				openProposal.current(e.item, true);
			}
		});
		input.current?.focus();
		return off;
	}, []);
	// The latest items, again whenever the chat moves (another conversation).
	// A box coming back reloads on its own (a "reset" event).
	// biome-ignore lint/correctness/useExhaustiveDependencies: home.box is the trigger: a new home is another conversation to load
	useEffect(() => {
		let live = true;
		void window.ateamLead.snapshot({ tail: PAGE }).then(
			(s) => live && setSnap(s),
			() => {},
		);
		return () => {
			live = false;
		};
	}, [home.box]);
	const [paging, setPaging] = useState(false);
	const showEarlier = () => {
		const first = snap.items[0];
		if (!first || paging) return;
		setPaging(true);
		pinned.current = false;
		void window.ateamLead
			.older(first.id, PAGE)
			.then(
				(page) =>
					setSnap((s) =>
						s.items[0]?.id === first.id
							? { ...s, items: [...page.items, ...s.items], more: page.more }
							: s,
					),
				(e) => setAttachNote(cleanError(e)),
			)
			.finally(() => setPaging(false));
	};

	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && pinned.current) el.scrollTop = el.scrollHeight;
	});
	// Content that sizes itself after it renders (a page's frame, a diagram)
	// grows the thread without a render here: keep the bottom in view.
	useEffect(() => {
		const el = scroller.current;
		const content = thread.current;
		if (!el || !content) return;
		const ro = new ResizeObserver(() => {
			if (pinned.current) el.scrollTop = el.scrollHeight;
		});
		ro.observe(content);
		return () => ro.disconnect();
	}, []);
	const atBottom = useCallback(() => pinned.current, []);
	// Switching replies in a stack is reading, not the thread growing: the card's
	// top stays in view, and a longer reply no longer counts as "at the bottom",
	// so the observer above doesn't jump to its last line.
	const keepInView = useCallback((card: HTMLElement) => {
		const el = scroller.current;
		if (!el) return;
		const above = card.getBoundingClientRect().top - el.getBoundingClientRect().top;
		if (above < 0) el.scrollTop += above - 8;
		pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
	}, []);
	// "Continues below" on a thread: its later card comes into view, showing
	// that task's thread (`n` makes a second click on the same one count).
	const [jump, setJump] = useState<{ block: string; key: string; n: number } | null>(null);
	const onContinue = useCallback((block: string, key: string) => {
		const card = thread.current?.querySelector<HTMLElement>(`[data-block="${CSS.escape(block)}"]`);
		card?.scrollIntoView({ block: "start", behavior: "smooth" });
		setJump((j) => ({ block, key, n: (j?.n ?? 0) + 1 }));
	}, []);

	const blocks = useMemo(() => toLeadBlocks(snap.items), [snap.items]);
	// A stack can hold only the user's answers, waiting on a task, and draws nothing.
	const drawn = blocks.some((b) => b.kind !== "threads" || b.threads.length > 0);
	// Every agent waiting on the user, newest first: they live on the tasks, not
	// in this conversation, so they stay put above the composer while it scrolls.
	const asking = useMemo(
		() =>
			tasks
				.filter((t) => t.question)
				.sort((a, b) => (b.question?.askedAt ?? 0) - (a.question?.askedAt ?? 0)),
		[tasks],
	);
	const lastBlock = blocks[blocks.length - 1];
	const toolRunning =
		lastBlock?.kind === "tools" && lastBlock.tools.some((t) => t.result === undefined);

	// A box's Lead sees that box's tasks only: the @ picker offers no others.
	const reachable = useMemo(
		() => (home.box ? tasks.filter(onLeadBox) : tasks),
		[home.box, tasks, onLeadBox],
	);
	const away = home.box !== null && !home.connected;

	const send = (body = text, attach = files) => {
		if (!body.trim() && !attach.length) return;
		pinned.current = true;
		ownTurn.current = true;
		window.ateamLead
			.send(
				expandRefs(body, refs),
				attach.map((f) => f.path),
			)
			.catch((e) => setAttachNote(cleanError(e)));
		setText("");
		setRefs([]);
		if (attach.length) setFiles(() => []);
		setAttachNote(null);
	};

	const took = (r: LeadAttachResult) => {
		setFiles((cur) => [...cur, ...r.files]);
		setAttachNote(r.failed.length ? r.failed.join(" ") : null);
		input.current?.focus();
	};
	/** Files from a drop or a paste: those on disk by their path, the rest (a
	 *  screenshot, an image dragged from a page) by their bytes. */
	const attachFiles = async (list: File[]) => {
		const paths = list.map((f) => window.ateam.utils.pathForFile(f));
		const result: LeadAttachResult = { files: [], failed: [] };
		try {
			const onDisk = paths.filter(Boolean);
			if (onDisk.length) {
				const r = await window.ateamLead.attach(onDisk);
				result.files.push(...r.files);
				result.failed.push(...r.failed);
			}
			for (const [i, f] of list.entries()) {
				if (paths[i]) continue;
				const data = new Uint8Array(await f.arrayBuffer());
				result.files.push(await window.ateamLead.attachBytes(f.name, data));
			}
		} catch (e) {
			result.failed.push(cleanError(e));
		}
		took(result);
	};
	const pickFiles = () =>
		void window.ateamLead.attach(null).then(took, (e) => setAttachNote(cleanError(e)));
	// A copied screenshot or Finder file arrives as files with no text; text
	// pastes as text.
	const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
		const dt = e.clipboardData;
		if (dt.getData("text/plain") || dt.files.length === 0) return;
		e.preventDefault();
		void attachFiles(Array.from(dt.files));
	};
	const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			send();
		}
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: a file dropped anywhere on the chat attaches it; the paperclip does the same from the keyboard
		<div
			className="lead"
			onDragOver={(e) => {
				if (!e.dataTransfer.types.includes("Files")) return;
				e.preventDefault();
				setDragging(true);
			}}
			onDragLeave={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
			}}
			onDrop={(e) => {
				setDragging(false);
				if (!e.dataTransfer.files.length) return;
				e.preventDefault();
				e.stopPropagation();
				void attachFiles(Array.from(e.dataTransfer.files));
			}}
		>
			{onHide ? (
				// The sidebar's top strip, level with the top bar beside it. Its hide
				// toggle sits where the top bar's show toggle was, so the button
				// doesn't move when the sidebar opens.
				<div className="lead-side-head">
					<span className="lead-side-title">Lead</span>
					{home.box && (
						<button
							type="button"
							className="lead-home"
							title={`The Lead runs on ${home.box}. Change it in Settings → Boxes.`}
							onClick={onOpenLeadSettings}
						>
							<span className={`lead-home-dot ${home.connected ? "on" : ""}`} />
							{home.box}
						</button>
					)}
					<IconButton
						icon={SquarePen}
						label="New conversation"
						size={14}
						disabled={snap.items.length === 0}
						onClick={() => void window.ateamLead.reset()}
					/>
					<IconButton
						icon={PanelRightFilled}
						label="Hide Lead sidebar"
						size={14}
						onClick={onHide}
					/>
				</div>
			) : (
				<div className="lead-head">
					<div>
						<h2>Lead</h2>
						<p>
							{scope ? (
								`${scope}'s own chat. The main window's chat covers every project.`
							) : home.box ? (
								<>
									Runs on{" "}
									<button
										type="button"
										className="lead-home"
										title="Change it in Settings → Boxes"
										onClick={onOpenLeadSettings}
									>
										<span className={`lead-home-dot ${home.connected ? "on" : ""}`} />
										{home.box}
									</button>{" "}
									and sees its tasks only. Your phone shares it when it picks that box.
								</>
							) : (
								"One chat for every task, on this Mac and on your boxes."
							)}
						</p>
					</div>
					<button
						type="button"
						className="iconbtn"
						title="New conversation"
						aria-label="New conversation"
						disabled={snap.items.length === 0}
						onClick={() => void window.ateamLead.reset()}
					>
						<SquarePen size={14} />
					</button>
				</div>
			)}

			<div
				className="lead-scroll"
				ref={scroller}
				onScroll={(e) => {
					const el = e.currentTarget;
					pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
				}}
			>
				<div className="lead-thread" ref={thread}>
					{snap.more && (
						<button type="button" className="lead-earlier" disabled={paging} onClick={showEarlier}>
							{paging ? "Loading…" : "Show earlier"}
						</button>
					)}
					{!drawn && !snap.busy && (
						<div className="lead-empty">
							{scope ? (
								<p>
									This chat is about {scope}. Ask about its tasks, start new ones, or send
									instructions to their agents. It can read your other projects too, and asks you
									before it messages one of their tasks.
								</p>
							) : (
								<p>
									Ask about your tasks, start new ones, or send instructions to the agents working
									on them.{" "}
									{home.box
										? `This Lead runs on ${home.box} and reads its board.`
										: "The Lead reads every board you're connected to."}
								</p>
							)}
							<div className="lead-suggest">
								{SUGGESTIONS.map((s) => (
									<button type="button" key={s} onClick={() => send(s, [])}>
										{s}
									</button>
								))}
							</div>
						</div>
					)}
					{blocks.map((b) =>
						b.kind === "tools" ? (
							<ToolGroup key={b.id} tools={b.tools} tasks={tasks} onOpenTask={onOpenTask} />
						) : b.kind === "threads" ? (
							<ThreadStack
								key={b.id}
								id={b.id}
								threads={b.threads}
								total={landed(b.items)}
								tasks={tasks}
								onOpenTask={onOpenTask}
								atBottom={atBottom}
								onPaged={keepInView}
								jump={jump}
								onContinue={onContinue}
								canReact={home.canReact}
							/>
						) : b.item.kind === "user" ? (
							<div key={b.item.id} className="lead-user">
								{b.item.files?.length ? (
									<div className="lead-files">
										{b.item.files.map((f) => (
											<Attachment key={f.path} file={f} />
										))}
									</div>
								) : null}
								<SentText text={b.item.text} renderTaskLink={renderTaskLink} />
							</div>
						) : b.item.kind === "permission" ? (
							<LeadPermission key={b.item.id} item={b.item} />
						) : b.item.kind === "proposal" ? (
							<LeadProposalCard
								key={b.item.id}
								item={b.item}
								tasks={tasks}
								onOpen={(item) => onOpenProposal(item, false)}
								onOpenTask={onOpenTask}
							/>
						) : b.item.kind === "assistant" ? (
							<div key={b.item.id} className="md">
								<TaskLinkContext value={renderTaskLink}>
									<Markdown text={b.item.text} />
								</TaskLinkContext>
							</div>
						) : b.item.kind === "notice" ? (
							<div key={b.item.id} className={`lead-notice ${b.item.tone}`}>
								{b.item.text}
								{b.item.task && (
									<TaskChip task={b.item.task} tasks={tasks} onOpenTask={onOpenTask} />
								)}
							</div>
						) : null,
					)}
					{snap.draft ? (
						<div className="md streaming">
							<TaskLinkContext value={renderTaskLink}>
								<Markdown text={snap.draft} />
							</TaskLinkContext>
						</div>
					) : (
						snap.busy && !toolRunning && <Thinking />
					)}
				</div>
			</div>

			{/* Only questions. A task in Needs You for another reason is on the
			    board, and one touched from this chat already replies into the
			    thread (main/lead/follow.ts), so a count here repeated both. */}
			{asking.length > 0 && (
				<div className="lead-asking">
					<div className="lead-asking-title">Waiting on you</div>
					<div className="lead-asking-list">
						{asking.map((t) => (
							<QuestionCard
								key={t.id}
								task={t}
								onOpenTask={onOpenTask}
								onAnswer={(input) =>
									// A box's Lead can't reach a task elsewhere: answer it directly.
									home.box && !onLeadBox(t)
										? window.ateam.tasks.answerQuestion(input).then(() => {})
										: window.ateamLead.answer(input)
								}
							/>
						))}
					</div>
				</div>
			)}

			<div className="lead-composer">
				{away && (
					<div className="lead-attach-note">
						{home.box} isn't connected. Sending connects it, waking it if it's asleep.
					</div>
				)}
				{attachNote && <div className="lead-attach-note">{attachNote}</div>}
				<div className={`lead-box ${dragging ? "dropping" : ""}`}>
					{files.length > 0 && (
						<div className="lead-files">
							{files.map((f) => (
								<Attachment
									key={f.path}
									file={f}
									onRemove={() => setFiles((cur) => cur.filter((x) => x.path !== f.path))}
								/>
							))}
						</div>
					)}
					<IconButton icon={Paperclip} label="Attach files" size={15} onClick={pickFiles} />
					{/* The ⚡ a new task gets, for the Lead's own Claude. It applies at once,
					    mid-turn included, and stays on for the next conversation. */}
					<button
						type="button"
						className={`iconbtn comp-yolo ${snap.auto ? "active" : ""}`}
						title="Auto mode"
						aria-label="Auto mode"
						aria-pressed={snap.auto}
						onClick={() =>
							void window.ateamLead.setAuto(!snap.auto).catch((e) => setAttachNote(cleanError(e)))
						}
					>
						<Zap size={15} strokeWidth={1.75} />
					</button>
					<TaskRefInput
						value={text}
						onChange={setText}
						refs={refs}
						onRefsChange={setRefs}
						tasks={reachable}
						projectName={projectName}
						inputRef={input}
						placeholder="Ask the Lead, @ a task"
						label="Message the Lead"
						onKeyDown={onKey}
						onPaste={onPaste}
					/>
					{snap.busy ? (
						<button
							type="button"
							className="lead-send"
							title="Stop"
							aria-label="Stop"
							onClick={() => void window.ateamLead.interrupt()}
						>
							<Square size={10} fill="currentColor" />
						</button>
					) : (
						<button
							type="button"
							className="lead-send"
							title="Send"
							aria-label="Send"
							disabled={!text.trim() && !files.length}
							onClick={() => send()}
						>
							<ArrowUp size={14} />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
