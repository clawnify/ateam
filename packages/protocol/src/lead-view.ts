// How a Lead chat draws its conversation, shared by every client that shows
// one (the desktop's LeadChat, the phone's LeadScreen): applying the pushed
// events to a snapshot, folding the items into blocks, and the one-line words
// for the Lead's tool calls. Pure; types only from the contract.

import type { TaskDTO } from "./index";
import type { LeadEvent, LeadItem, LeadSnapshot } from "./lead";

export type LeadToolItem = Extract<LeadItem, { kind: "tool" }>;
export type LeadAgentItem = Extract<LeadItem, { kind: "agent" }>;
export type LeadBlock =
	| { kind: "item"; item: LeadItem }
	| { kind: "tools"; id: string; tools: LeadToolItem[] }
	| { kind: "agents"; id: string; replies: LeadAgentItem[] };

/** Consecutive tool calls read as one step, so they fold into one row.
 *  Consecutive agent replies fold into one card. Anything else in between (the
 *  user's message, the Lead's, a page, a notice) starts a new block. A block's
 *  id is its first item's, which never changes as more join it. */
export function toLeadBlocks(items: LeadItem[]): LeadBlock[] {
	const out: LeadBlock[] = [];
	for (const item of items) {
		const last = out[out.length - 1];
		if (item.kind === "tool") {
			if (last?.kind === "tools") last.tools.push(item);
			else out.push({ kind: "tools", id: item.id, tools: [item] });
		} else if (item.kind === "agent") {
			if (last?.kind === "agents") last.replies.push(item);
			else out.push({ kind: "agents", id: item.id, replies: [item] });
		} else out.push({ kind: "item", item });
	}
	return out;
}

export function applyLeadEvent(s: LeadSnapshot, e: LeadEvent): LeadSnapshot {
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
