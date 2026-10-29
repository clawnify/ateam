// The Lead chat: one conversation with a coordinator agent that starts, steers
// and reads every task on every engine (main/lead). Native rendering, not a
// terminal: the user's messages, the Lead's prose, and its board moves folded
// into one line each, with the tasks it touched as chips that open the task.
import type { TaskDTO } from "@ateam/protocol";
import {
	ArrowUp,
	ChevronRight,
	CornerDownRight,
	LoaderCircle,
	Square,
	SquarePen,
} from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { LeadEvent, LeadItem, LeadSnapshot, LeadTaskRef } from "../../../shared/lead";
import { AgentIcon } from "./AgentIcon";
import { Markdown } from "./Markdown";
import { QuestionCard } from "./QuestionCard";

type ToolItem = Extract<LeadItem, { kind: "tool" }>;
type Block = { kind: "item"; item: LeadItem } | { kind: "tools"; id: string; tools: ToolItem[] };

const EMPTY: LeadSnapshot = { items: [], draft: "", busy: false };

const SUGGESTIONS = [
	"What's on the board?",
	"Which tasks need me?",
	"What did the last finished task say?",
];

function apply(s: LeadSnapshot, e: LeadEvent): LeadSnapshot {
	switch (e.type) {
		case "item": {
			const at = s.items.findIndex((i) => i.id === e.item.id);
			if (at < 0) return { ...s, items: [...s.items, e.item] };
			const items = s.items.slice();
			items[at] = e.item;
			return { ...s, items };
		}
		case "draft":
			return { ...s, draft: e.text };
		case "busy":
			return { ...s, busy: e.busy };
		case "reset":
			return e.snapshot;
	}
}

/** Consecutive tool calls read as one step, so they fold into one row. */
function toBlocks(items: LeadItem[]): Block[] {
	const out: Block[] = [];
	for (const item of items) {
		const last = out[out.length - 1];
		if (item.kind === "tool") {
			if (last?.kind === "tools") last.tools.push(item);
			else out.push({ kind: "tools", id: item.id, tools: [item] });
		} else out.push({ kind: "item", item });
	}
	return out;
}

/** create_task answers "Started task "x" (<uuid>) ..."; the id is the chip's target. */
const TASK_ID = /\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/;

function findTask(tasks: TaskDTO[], ref: unknown): TaskDTO | undefined {
	if (typeof ref !== "string") return undefined;
	const want = ref.toLowerCase();
	return (
		tasks.find((t) => t.id === ref) ??
		tasks.find((t) => t.name.toLowerCase() === want || t.branch.toLowerCase() === want)
	);
}

/** The task a tool call acted on, when it acted on one. */
function toolTask(tool: ToolItem, tasks: TaskDTO[]): TaskDTO | undefined {
	if (tool.name === "create_task") {
		const id = tool.result?.match(TASK_ID)?.[1];
		return id ? tasks.find((t) => t.id === id) : undefined;
	}
	return findTask(tasks, tool.input.task);
}

function describe(tool: ToolItem, tasks: TaskDTO[]): string {
	const name = toolTask(tool, tasks)?.name ?? String(tool.input.name ?? tool.input.task ?? "");
	switch (tool.name) {
		case "get_board":
			return "Read the board";
		case "read_task":
			return `Read ${name}`;
		case "create_task":
			return `Started ${name}`;
		case "send_message":
			return `Messaged ${name}`;
		default:
			return tool.name;
	}
}

function ToolGroup({
	tools,
	tasks,
	onOpenTask,
}: {
	tools: ToolItem[];
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
		.map((t) => ({ tool: t, task: toolTask(t, tasks) }))
		.filter((x): x is { tool: ToolItem; task: TaskDTO } => x.task != null);
	return (
		<div className="lead-tools">
			<button type="button" className="lead-tools-head" onClick={() => setOpen((o) => !o)}>
				{running ? (
					<LoaderCircle size={12} className="spin" />
				) : (
					<ChevronRight size={12} className={open ? "lead-chev open" : "lead-chev"} />
				)}
				<span className="lead-tools-sum">{tools.map((t) => describe(t, tasks)).join(" · ")}</span>
				{failed > 0 && <span className="lead-tools-failed">{failed} failed</span>}
			</button>
			{open && (
				<div className="lead-tools-body">
					{tools.map((t) => (
						<div key={t.id} className={t.isError ? "lead-tool error" : "lead-tool"}>
							<div className="lead-tool-name">{t.name}</div>
							{Object.keys(t.input).length > 0 && (
								<pre className="lead-tool-io">{JSON.stringify(t.input, null, 2)}</pre>
							)}
							{t.result !== undefined && <pre className="lead-tool-io">{t.result}</pre>}
						</div>
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

/** An IPC rejection carries Electron's prefix before the engine's own words. */
const cleanError = (e: unknown) =>
	(e instanceof Error ? e.message : String(e)).replace(
		/^Error invoking remote method '[^']+': (Error: )?/,
		"",
	);

/** A task named in the thread; opens it when it is on a board this window has loaded. */
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
		>
			<AgentIcon agentId={task.agentId} size={12} />
			<span className="lead-chip-name">{task.name}</span>
		</button>
	);
}

/** A followed task's agent, talking back: its reply, and a box to answer it here. */
function AgentReply({
	item,
	tasks,
	onOpenTask,
}: {
	item: Extract<LeadItem, { kind: "agent" }>;
	tasks: TaskDTO[];
	onOpenTask: (t: TaskDTO) => void;
}) {
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (!text.trim()) return;
		setSending(true);
		setError(null);
		try {
			await window.ateamLead.reply(item.task.taskId, text);
			setText("");
			setOpen(false);
		} catch (err) {
			setError(cleanError(err));
		} finally {
			setSending(false);
		}
	};
	return (
		<div className="lead-agent">
			<div className="lead-agent-head">
				<TaskChip task={item.task} tasks={tasks} onOpenTask={onOpenTask} />
				<span className="lead-agent-said">replied</span>
			</div>
			<div className="md">
				<Markdown text={item.text} />
			</div>
			{open ? (
				<form className="question-reply" onSubmit={submit}>
					<input
						// biome-ignore lint/a11y/noAutofocus: opened by the user's own click on Reply.
						autoFocus
						value={text}
						placeholder={`Reply to ${item.task.name}`}
						aria-label={`Reply to ${item.task.name}`}
						disabled={sending}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
					/>
					<button type="submit" disabled={sending || !text.trim()}>
						Send
					</button>
				</form>
			) : (
				<button type="button" className="lead-agent-reply" onClick={() => setOpen(true)}>
					<CornerDownRight size={12} />
					Reply
				</button>
			)}
			{error && <p className="question-error">{error}</p>}
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
			<LoaderCircle size={12} className="spin" />
			Working{secs > 0 ? ` for ${secs}s` : ""}
		</div>
	);
}

export function LeadChat({
	tasks,
	onOpenTask,
}: {
	/** Every loaded task, across projects and machines, to name and open the ones the Lead touches. */
	tasks: TaskDTO[];
	onOpenTask: (t: TaskDTO) => void;
}) {
	const [snap, setSnap] = useState<LeadSnapshot>(EMPTY);
	const [text, setText] = useState("");
	const scroller = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	// Follow the conversation only while the user is at the bottom of it.
	const pinned = useRef(true);

	useEffect(() => {
		let live = true;
		const off = window.ateamLead.onEvent((e) => setSnap((s) => apply(s, e)));
		void window.ateamLead.snapshot().then((s) => live && setSnap(s));
		input.current?.focus();
		return () => {
			live = false;
			off();
		};
	}, []);

	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && pinned.current) el.scrollTop = el.scrollHeight;
	});

	const blocks = useMemo(() => toBlocks(snap.items), [snap.items]);
	// Every agent waiting on the user, newest first: they live on the tasks, not
	// in this conversation, so they stay put above the composer while it scrolls.
	const asking = useMemo(
		() =>
			tasks
				.filter((t) => t.question)
				.sort((a, b) => (b.question?.askedAt ?? 0) - (a.question?.askedAt ?? 0)),
		[tasks],
	);
	// In Needs You for another reason (a finished turn that asks in prose, a
	// prompt in its terminal): counted, not listed, so a busy board can't bury
	// the questions; the Lead can go through them.
	const waiting = useMemo(
		() => tasks.filter((t) => t.column === "needs_attention" && !t.question).length,
		[tasks],
	);
	const lastBlock = blocks[blocks.length - 1];
	const toolRunning =
		lastBlock?.kind === "tools" && lastBlock.tools.some((t) => t.result === undefined);

	const send = (body = text) => {
		if (!body.trim()) return;
		pinned.current = true;
		void window.ateamLead.send(body);
		setText("");
	};
	const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			send();
		}
	};

	return (
		<div className="lead">
			<div className="lead-head">
				<div>
					<h2>Lead</h2>
					<p>One chat for every task, on this Mac and on your boxes.</p>
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

			<div
				className="lead-scroll"
				ref={scroller}
				onScroll={(e) => {
					const el = e.currentTarget;
					pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
				}}
			>
				<div className="lead-thread">
					{blocks.length === 0 && !snap.busy && (
						<div className="lead-empty">
							<p>
								Ask about your tasks, start new ones, or send instructions to the agents working on
								them. The Lead reads every board you're connected to.
							</p>
							<div className="lead-suggest">
								{SUGGESTIONS.map((s) => (
									<button type="button" key={s} onClick={() => send(s)}>
										{s}
									</button>
								))}
							</div>
						</div>
					)}
					{blocks.map((b) =>
						b.kind === "tools" ? (
							<ToolGroup key={b.id} tools={b.tools} tasks={tasks} onOpenTask={onOpenTask} />
						) : b.item.kind === "user" ? (
							<div key={b.item.id} className="lead-user">
								{b.item.to && <div className="lead-user-to">to {b.item.to.name}</div>}
								{b.item.text}
							</div>
						) : b.item.kind === "agent" ? (
							<AgentReply key={b.item.id} item={b.item} tasks={tasks} onOpenTask={onOpenTask} />
						) : b.item.kind === "assistant" ? (
							<div key={b.item.id} className="md">
								<Markdown text={b.item.text} />
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
							<Markdown text={snap.draft} />
						</div>
					) : (
						snap.busy && !toolRunning && <Thinking />
					)}
				</div>
			</div>

			{(asking.length > 0 || waiting > 0) && (
				<div className="lead-asking">
					<div className="lead-asking-title">Waiting on you</div>
					{asking.map((t) => (
						<QuestionCard
							key={t.id}
							task={t}
							onOpenTask={onOpenTask}
							onAnswer={(input) => window.ateamLead.answer(input)}
						/>
					))}
					{waiting > 0 && (
						<div className="lead-waiting">
							{waiting === 1 ? "1 other task is" : `${waiting} other tasks are`} in Needs you
							without a question.
							<button
								type="button"
								disabled={snap.busy}
								onClick={() => send("Go through the tasks that need me: what does each one need?")}
							>
								Ask the Lead
							</button>
						</div>
					)}
				</div>
			)}

			<div className="lead-composer">
				<textarea
					ref={input}
					value={text}
					rows={1}
					placeholder="Message the Lead"
					onChange={(e) => setText(e.target.value)}
					onKeyDown={onKey}
				/>
				{snap.busy ? (
					<button
						type="button"
						className="lead-send"
						title="Stop"
						aria-label="Stop"
						onClick={() => void window.ateamLead.interrupt()}
					>
						<Square size={12} fill="currentColor" />
					</button>
				) : (
					<button
						type="button"
						className="lead-send"
						title="Send"
						aria-label="Send"
						disabled={!text.trim()}
						onClick={() => send()}
					>
						<ArrowUp size={14} />
					</button>
				)}
			</div>
		</div>
	);
}
