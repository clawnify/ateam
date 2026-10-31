// The Lead chat: one conversation with a coordinator agent that starts, steers
// and reads every task on every engine (main/lead). Native rendering, not a
// terminal: the user's messages, the Lead's prose, and its board moves folded
// into one line each, with the tasks it touched as chips that open the task.
import type { TaskDTO } from "@ateam/protocol";
import {
	ArrowUp,
	ChevronRight,
	CircleHelp,
	CornerDownRight,
	Square,
	SquarePen,
} from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type {
	LeadEvent,
	LeadItem,
	LeadPermissionAnswer,
	LeadSnapshot,
	LeadTaskRef,
} from "../../../shared/lead";
import { AgentIcon } from "./AgentIcon";
import { IconButton } from "./IconButton";
import { Markdown, TaskLinkContext } from "./Markdown";
import { PageFrame } from "./PageFrame";
import { PanelRightFilled } from "./PanelRightFilled";
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

/** An MCP tool's server and tool, "mcp__claude_ai_Granola__get_meetings" →
 *  ["Granola", "get meetings"]: the names the user knows them by. */
function mcpParts(name: string): [string, string] | null {
	const m = /^mcp__(.+?)__(.+)$/.exec(name);
	if (!m) return null;
	const [, server = "", tool = ""] = m;
	return [server.replace(/^claude_ai_/, "").replace(/_/g, " "), tool.replace(/_/g, " ")];
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** What a step did, in the words a group summary counts: the Lead's own board
 *  tools, then the user's Claude Code tools and connectors. */
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
		case "answer_question":
			return `Answered ${name}`;
		case "Bash":
			return "Ran a command";
		case "Read":
			return "Read a file";
		case "Write":
			return "Wrote a file";
		case "Edit":
		case "MultiEdit":
		case "NotebookEdit":
			return "Edited a file";
		case "Glob":
		case "Grep":
			return "Searched files";
		case "WebFetch":
			return "Fetched a page";
		case "WebSearch":
			return "Searched the web";
		case "Skill":
			return `Used ${str(tool.input.skill) || "a skill"}`;
		case "Task":
		case "Agent":
			return "Ran a subagent";
		case "TodoWrite":
			return "Updated the plan";
		case "ToolSearch":
			return "Loaded tools";
	}
	const mcp = mcpParts(tool.name);
	return mcp ? `Used ${mcp[0]}` : tool.name;
}

/** One step in an opened group, more specifically: which command, which file. */
function stepLabel(tool: ToolItem, tasks: TaskDTO[]): string {
	const i = tool.input;
	const detail =
		tool.name === "Bash"
			? str(i.description) || str(i.command)
			: ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool.name)
				? str(i.file_path) || str(i.notebook_path)
				: tool.name === "Grep" || tool.name === "Glob"
					? str(i.pattern)
					: tool.name === "WebFetch"
						? str(i.url)
						: tool.name === "WebSearch"
							? str(i.query)
							: "";
	if (detail) return detail.length > 90 ? `${detail.slice(0, 89)}…` : detail;
	const mcp = mcpParts(tool.name);
	return mcp ? `${mcp[0]}: ${mcp[1]}` : describe(tool, tasks);
}

/** The group as one sentence, the way Claude and Cursor fold their tool calls:
 *  "Read the board, messaged landing page copy". A repeated step is counted. */
function summarize(tools: ToolItem[], tasks: TaskDTO[]): string {
	const counts = new Map<string, number>();
	for (const t of tools) {
		const d = describe(t, tasks);
		counts.set(d, (counts.get(d) ?? 0) + 1);
	}
	const parts = [...counts].map(([d, n], i) => {
		const phrase = i === 0 ? d : d.charAt(0).toLowerCase() + d.slice(1);
		return n > 1 ? `${phrase} (${n}×)` : phrase;
	});
	return parts.join(", ");
}

/** What a step came back with, in a few words: the row is a summary, the raw
 *  result opens below. Board reads count rows; task reads give where it is. */
function resultSummary(tool: ToolItem): string {
	const text = tool.result ?? "";
	if (tool.name === "get_board") {
		const rows = text.split("\n").filter((l) => / \| /.test(l)).length - 1;
		return rows > 0 ? `${rows} task${rows === 1 ? "" : "s"}` : "nothing matches";
	}
	if (tool.name === "read_task") {
		try {
			const t = JSON.parse(text) as { column?: string; state?: string };
			return [t.column, t.state].filter(Boolean).join(", ");
		} catch {
			/* an error text: shown as it is below */
		}
	}
	return (
		text
			.split("\n")
			.find((l) => /\w/.test(l))
			?.trim()
			.slice(0, 140) ?? ""
	);
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
			<button
				type="button"
				className="lead-tools-head"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
			>
				<span className={running ? "lead-tools-sum shimmer" : "lead-tools-sum"}>
					{summarize(tools, tasks)}
				</span>
				{failed > 0 && <span className="lead-tools-failed">Failed</span>}
				<ChevronRight size={12} className={open ? "lead-chev open" : "lead-chev"} />
			</button>
			{open && (
				<div className="lead-steps">
					{tools.map((t) => (
						<ToolStep key={t.id} tool={t} label={stepLabel(t, tasks)} solo={tools.length === 1} />
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

/** One step in an opened group: what it did and how it ended; its raw input
 *  and result open below on a click, for when the summary isn't enough. */
function ToolStep({ tool, label, solo }: { tool: ToolItem; label: string; solo: boolean }) {
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
					!running && <span className="lead-step-result">{resultSummary(tool)}</span>
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
	const task = findTask(tasks, target);
	return (
		<button
			type="button"
			className="lead-chip"
			title={task ? `Open ${task.name}` : "Not on a board this window has loaded"}
			disabled={!task}
			onClick={() => task && onOpenTask(task)}
		>
			{task && <AgentIcon agentId={task.agentId} size={12} />}
			<span className="lead-chip-name">{label}</span>
		</button>
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
			<span className="shimmer">Working{secs > 0 ? ` for ${secs}s` : "…"}</span>
		</div>
	);
}

/** What the user has typed and not sent. Outlives the component, because the
 *  chat moves between the Lead tab and the sidebar by unmounting one and
 *  mounting the other, and hiding the sidebar unmounts it too. */
let unsent = "";

export function LeadChat({
	tasks,
	onOpenTask,
	onHide,
}: {
	/** Every loaded task, across projects and machines, to name and open the ones the Lead touches. */
	tasks: TaskDTO[];
	onOpenTask: (t: TaskDTO) => void;
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
	// The Lead names tasks as links (its prompt says how); each is drawn as a
	// chip that opens the task.
	const renderTaskLink = useCallback(
		(target: string, label: ReactNode) => (
			<TaskLink target={target} label={label} tasks={tasks} onOpenTask={onOpenTask} />
		),
		[tasks, onOpenTask],
	);
	const scroller = useRef<HTMLDivElement>(null);
	const thread = useRef<HTMLDivElement>(null);
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
			{onHide ? (
				// The sidebar's top strip, level with the top bar beside it. Its hide
				// toggle sits where the top bar's show toggle was, so the button
				// doesn't move when the sidebar opens.
				<div className="lead-side-head">
					<span className="lead-side-title">Lead</span>
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
						) : b.item.kind === "permission" ? (
							<LeadPermission key={b.item.id} item={b.item} />
						) : b.item.kind === "page" ? (
							<div key={b.item.id} className="lead-agent">
								<div className="lead-agent-head">
									<TaskChip task={b.item.task} tasks={tasks} onOpenTask={onOpenTask} />
									<span className="lead-agent-said">made a page</span>
								</div>
								<PageFrame
									taskId={b.item.task.taskId}
									pageId={b.item.pageId}
									title={b.item.title}
								/>
							</div>
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
				<div className="lead-box">
					<textarea
						ref={input}
						value={text}
						rows={1}
						placeholder="Message the Lead"
						aria-label="Message the Lead"
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
							<Square size={10} fill="currentColor" />
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
		</div>
	);
}
