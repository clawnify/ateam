// How a Lead chat draws its conversation, shared by every client that shows
// one (the desktop's LeadChat, the phone's LeadScreen): applying the pushed
// events to a snapshot, folding the items into blocks, and the one-line words
// for the Lead's tool calls. Pure; types only from the contract.

import type { TaskDTO } from "./index";
import type { LeadEvent, LeadItem, LeadSnapshot, LeadTaskRef } from "./lead";

export type LeadToolItem = Extract<LeadItem, { kind: "tool" }>;
export type LeadAgentItem = Extract<LeadItem, { kind: "agent" }>;
export type LeadPageItem = Extract<LeadItem, { kind: "page" }>;

/** What a task's thread holds: the task's replies and pages, what the user
 *  sent it from the chat (a reply, an answer to its question), and notices
 *  about it (stopped at a prompt). */
export type LeadThreadEntry =
	| LeadAgentItem
	| LeadPageItem
	| (Extract<LeadItem, { kind: "user" }> & { to: LeadTaskRef })
	| (Extract<LeadItem, { kind: "notice" }> & { task: LeadTaskRef });

/** One task's conversation with the user, as one card shows it. */
export interface LeadThread {
	/** The task's id. */
	key: string;
	/** The task, as its latest entry names it. */
	task: LeadTaskRef;
	/** This card's entries, oldest first. */
	entries: LeadThreadEntry[];
	/** The same task's entries in earlier cards of this conversation, oldest first. */
	earlier: LeadThreadEntry[];
	/** The id of the later block where this thread goes on, once there is one. */
	continuedIn: string | null;
}

export type LeadBlock =
	| { kind: "item"; item: Exclude<LeadItem, { kind: "tool" | "agent" | "page" }> }
	| { kind: "tools"; id: string; tools: LeadToolItem[] }
	/** Tasks talking back, one after another: a thread per task, ordered by
	 *  each task's latest entry of its own (the last is the newest). `items` is
	 *  every entry in the order it arrived, the user's held ones too, so it can
	 *  hold entries and no thread yet. */
	| { kind: "threads"; id: string; items: LeadThreadEntry[]; threads: LeadThread[] };

/** The task an item belongs to, when it goes in that task's thread. */
function threadTask(item: LeadItem): LeadTaskRef | undefined {
	switch (item.kind) {
		case "agent":
		case "page":
			return item.task;
		case "user":
			return item.to;
		case "notice":
			return item.task;
		default:
			return undefined;
	}
}

/** Consecutive tool calls read as one step, so they fold into one row.
 *  Consecutive task items (replies, pages, the user's answers to them) fold
 *  into one card, a thread per task. Anything else in between (the user's
 *  message to the Lead, the Lead's) starts a new block, and a task that talks
 *  again after it gets a new thread there: nothing already drawn moves. That
 *  thread carries the task's earlier entries, and the earlier thread points
 *  to it. A block's id is its first item's, which never changes as more join it.
 *
 *  Only a task's own entries (replies, pages, notices) open a thread or move
 *  it to the end. The user's words join the task's thread in the stack where
 *  it stands. With no thread there (an answer to a question, a reply from an
 *  earlier card) they open no page: they wait, and the task's next thread
 *  opens with them. */
export function toLeadBlocks(items: LeadItem[]): LeadBlock[] {
	const out: LeadBlock[] = [];
	/** Each task's entries so far in the conversation's threads. */
	const history = new Map<string, LeadThreadEntry[]>();
	/** Each task's latest thread, to point at the one that continues it. */
	const latest = new Map<string, LeadThread>();
	/** The user's words to a task with no thread in the stack they joined. */
	const held = new Map<string, LeadThreadEntry[]>();
	for (const item of items) {
		const last = out[out.length - 1];
		const task = threadTask(item);
		if (task) {
			const entry = item as LeadThreadEntry;
			let block = last?.kind === "threads" ? last : undefined;
			if (!block) {
				block = { kind: "threads", id: item.id, items: [], threads: [] };
				out.push(block);
			}
			block.items.push(entry);
			const key = task.taskId;
			const seen = history.get(key) ?? [];
			let thread = block.threads.find((t) => t.key === key);
			if (entry.kind === "user") {
				if (thread) {
					thread.task = task;
					thread.entries.push(entry);
					seen.push(entry);
					history.set(key, seen);
				} else held.set(key, [...(held.get(key) ?? []), entry]);
				continue;
			}
			const waiting = held.get(key) ?? [];
			held.delete(key);
			if (thread) block.threads.splice(block.threads.indexOf(thread), 1);
			else {
				const before = latest.get(key);
				if (before) before.continuedIn = block.id;
				thread = { key, task, entries: [], earlier: seen.slice(), continuedIn: null };
				latest.set(key, thread);
			}
			// The newest talker goes last, where the card opens.
			block.threads.push(thread);
			thread.task = task;
			thread.entries.push(...waiting, entry);
			seen.push(...waiting, entry);
			history.set(key, seen);
		} else if (item.kind === "tool") {
			if (last?.kind === "tools") last.tools.push(item);
			else out.push({ kind: "tools", id: item.id, tools: [item] });
		} else if (item.kind !== "agent" && item.kind !== "page") out.push({ kind: "item", item });
	}
	return out;
}

export function applyLeadEvent(s: LeadSnapshot, e: LeadEvent): LeadSnapshot {
	switch (e.type) {
		case "item": {
			const at = s.items.findIndex((i) => i.id === e.item.id);
			// A client holding only the tail (`more`) gets updates to items it never
			// loaded too (a proposal's outcome); one older than all it has belongs
			// to history it pages in later, not at the bottom of the thread.
			if (at < 0 && s.more && s.items[0] && e.item.at < s.items[0].at) return s;
			if (at < 0) return { ...s, items: [...s.items, e.item] };
			const items = s.items.slice();
			items[at] = e.item;
			return { ...s, items };
		}
		case "draft":
			return { ...s, draft: e.text };
		case "busy":
			return { ...s, busy: e.busy };
		case "auto":
			return { ...s, auto: e.auto };
		case "reset":
			return e.snapshot;
	}
}

/** create_task (the Lead's tool before it proposed instead, still in older
 *  conversations) answered "Started task "x" (<uuid>) ..."; the id is the chip's target. */
const TASK_ID = /\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/;

export function findLeadTask(tasks: TaskDTO[], ref: unknown): TaskDTO | undefined {
	if (typeof ref !== "string") return undefined;
	const want = ref.toLowerCase();
	return (
		tasks.find((t) => t.id === ref) ??
		tasks.find((t) => t.name.toLowerCase() === want || t.branch.toLowerCase() === want)
	);
}

/** The task a link in the Lead's prose names, `[label](task:<target>)`. The
 *  Lead copies ids from get_board and now and then garbles one (keeping the
 *  first eight characters, inventing the rest), or links a task before it has
 *  an id. A tool call given a bad ref hears "no task" and retries; a link just
 *  draws a dead chip. So after an exact match comes the one task whose id
 *  starts like the target, then the one task the link's text names. Tool calls
 *  keep to findLeadTask: their chip names the task the server resolved. */
export function findLinkedTask(
	tasks: TaskDTO[],
	target: string,
	label: string,
): TaskDTO | undefined {
	const exact = findLeadTask(tasks, target);
	if (exact) return exact;
	const head = /^[0-9a-f]{8}/i.exec(target)?.[0].toLowerCase();
	const sameHead = head ? tasks.filter((t) => t.id.startsWith(head)) : [];
	if (sameHead.length === 1) return sameHead[0];
	const want = label.trim().toLowerCase();
	const named = want ? tasks.filter((t) => t.name.toLowerCase() === want) : [];
	return named.length === 1 ? named[0] : undefined;
}

/** The task a tool call acted on, when it acted on one. */
export function leadToolTask(tool: LeadToolItem, tasks: TaskDTO[]): TaskDTO | undefined {
	if (tool.name === "create_task") {
		const id = tool.result?.match(TASK_ID)?.[1];
		return id ? tasks.find((t) => t.id === id) : undefined;
	}
	return findLeadTask(tasks, tool.input.task);
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
export function describeLeadTool(tool: LeadToolItem, tasks: TaskDTO[]): string {
	const name = leadToolTask(tool, tasks)?.name ?? String(tool.input.name ?? tool.input.task ?? "");
	switch (tool.name) {
		case "get_board":
			return "Read the board";
		case "read_task":
			return `Read ${name}`;
		case "create_task":
			return `Started ${name}`;
		case "propose_task":
			return `Proposed ${name}`;
		case "propose_loop":
			return `Proposed the loop ${name}`;
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
export function leadToolStep(tool: LeadToolItem, tasks: TaskDTO[]): string {
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
	return mcp ? `${mcp[0]}: ${mcp[1]}` : describeLeadTool(tool, tasks);
}

/** The group as one sentence, the way Claude and Cursor fold their tool calls:
 *  "Read the board, messaged landing page copy". A repeated step is counted. */
export function summarizeLeadTools(tools: LeadToolItem[], tasks: TaskDTO[]): string {
	const counts = new Map<string, number>();
	for (const t of tools) {
		const d = describeLeadTool(t, tasks);
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
export function leadToolResult(tool: LeadToolItem): string {
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
