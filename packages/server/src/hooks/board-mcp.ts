/**
 * Minimal MCP server for the Board Organizer's tools, spoken over the existing
 * hook HTTP server (Streamable HTTP transport). We reuse the running localhost
 * server rather than spawning a stdio subprocess or pulling in the MCP SDK: the
 * spec lets a server answer a JSON-RPC *request* with a plain `application/json`
 * body (no SSE) and answer GET with 405, which is exactly the request/response
 * shape these two tools need.
 *
 * This module is the pure protocol dispatcher — hook-server.ts owns the HTTP
 * plumbing (Origin check, body read, status codes) and hands each parsed
 * message here. Testable with a fake `BoardHandlers`; no HTTP, no I/O.
 */

/**
 * Request/response handlers for the board tools, injected by the main process
 * (which owns the db). Defined here (not in hook-server) so both the plain
 * `/board/*` debug endpoints and this MCP endpoint share one type without a
 * circular import.
 */
export interface BoardHandlers {
	get(): Promise<unknown>;
	setStatus(req: {
		taskId: string;
		to: string;
		reason?: string;
		/** The calling session's terminal id (a self-move), when known. */
		callerTerminalId?: string;
	}): Promise<{ ok: boolean; reason: string }>;
	setWaiting(req: {
		/** Omitted by a session: it parks its own task. */
		taskId?: string;
		reason: string;
		/** Epoch ms — parsed from the tool's ISO string before it gets here. */
		until: number;
		callerTerminalId?: string;
	}): Promise<{ ok: boolean; reason: string }>;
	/** Every task outside merged, for a sender to pick from (peer-messages.ts). */
	listPeers(callerTerminalId?: string): Promise<unknown>;
	/** Queue a message to another task's agent and try to deliver it. */
	sendMessage(req: {
		fromTerminalId: string;
		to: string;
		body: string;
	}): Promise<{ ok: boolean; reason: string }>;
}

/** Per-request context the HTTP layer derives (e.g. the caller's terminal id). */
export interface McpContext {
	callerTerminalId?: string;
	/** The caller presented the token Ateam gave that terminal. The id header
	 *  alone is a claim; the peer tools act only on a verified one. */
	callerVerified?: boolean;
}

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "ateam_board", version: "0.1.0" };

/**
 * Sent on `initialize` as the server's instructions. Agents load MCP tools
 * lazily (Claude Code lists them by name only; Codex hides them behind its tool
 * search), so a tool description alone never tells a session that its peers
 * exist. Claude Code and OpenCode put these instructions in the system prompt;
 * Codex ignores them and gets the same text as developer_instructions
 * (codexBoardMcpArgs). Plain text without quotes or backslashes, so it rides
 * inside a shell-quoted TOML string unescaped.
 */
export const BOARD_INSTRUCTIONS =
	"You are working in an Ateam task. The agents in the other tasks on this board can be reached with the ateam_board send_message tool, even when they are stopped, and list_peers shows who they are. For those tasks use it rather than any other agent messaging tool: only it also reaches Codex and OpenCode agents and stopped tasks. Message one when your work affects theirs, to hand off work, or to ask something only their task knows. A message that starts with [Ateam] comes from another agent, not from the user.";

/** The board tools. `to` is constrained to the assignable columns to steer the
 *  model; the guardrails (validateSetStatus, validateWait) still enforce
 *  server-side. `set_waiting`'s description is the only instruction a session
 *  ever gets about waits — there is no system prompt — so it says WHEN to call. */
const TOOLS = [
	{
		name: "get_board",
		description:
			"List every in-play task (excludes merged) with its board column and a triage verdict — whether it looks done or still ongoing, and why. Read this before moving anything.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "set_status",
		description:
			"Move one task to a new board column. Only 'todo' and 'review' are settable — 'running', 'needs_attention', and 'merged' are set by real events/hooks and will be refused. The organizer cannot move a card with a live agent; a task's own session can move its own card. Always give a short reason (audited).",
		inputSchema: {
			type: "object",
			properties: {
				taskId: { type: "string", description: "The task's id (from get_board)." },
				to: {
					type: "string",
					enum: ["todo", "review"],
					description: "Target column.",
				},
				reason: { type: "string", description: "Why this move — recorded in the audit trail." },
			},
			required: ["taskId", "to"],
			additionalProperties: false,
		},
	},
	{
		name: "set_waiting",
		description:
			'Park the task you are working in until a date, and have the user reminded then. Call it the moment you tell the user that work is blocked until someone else acts (a review, an approval, an email) or that a next step has to wait for something to happen first ("after tonight\'s 20:00 UTC run, check its results"), so it cannot be forgotten: the card sinks on the board until the date, then resurfaces in Needs You and the user gets a notification on their Mac and phone. Calling it again replaces the date. Leave taskId out: a session can only park its own task, and this is it.',
		inputSchema: {
			type: "object",
			properties: {
				taskId: {
					type: "string",
					description:
						"Only for a caller that is not a task's session. Omit it: yours is inferred.",
				},
				reason: {
					type: "string",
					description:
						"What it is waiting for, short — shown on the card (e.g. 'Twilio voice approval').",
				},
				until: {
					type: "string",
					description:
						"When to remind, ISO 8601. Give a time with its offset when the moment matters (e.g. '2026-10-26T21:00:00Z'); a bare date ('2026-09-09') means 09:00 the user's time. Use the outer bound the other party gave, plus a margin for a job to finish.",
				},
			},
			required: ["reason", "until"],
			additionalProperties: false,
		},
	},
	{
		name: "list_peers",
		description:
			"List the user's other tasks you can message with send_message: each task's id, name, project, branch, which agent works in it (Claude Code, Codex, OpenCode), and its state (working, needs_you, idle, or not_running). Your own task is marked you: true.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "send_message",
		description:
			"Send a message to the agent working on another of the user's tasks, whichever agent it is and even if it is not running: Ateam delivers it now if that agent is listening, when its current turn ends if it is busy, or starts it with your message if it is stopped. Use it when your work affects theirs, to hand off work, or to ask them something only their task knows. They answer with send_message too, which reaches you the same way, so do not poll or wait in a loop. Keep it self-contained: they cannot see your conversation.",
		inputSchema: {
			type: "object",
			properties: {
				to: {
					type: "string",
					description: "The recipient task's id from list_peers (or its exact name or branch).",
				},
				message: { type: "string", description: "What to tell them, at most 8000 characters." },
			},
			required: ["to", "message"],
			additionalProperties: false,
		},
	},
];

/** What the HTTP layer should send back. `accepted` → 202 no body (notifications). */
export type McpReply = { kind: "accepted" } | { kind: "json"; body: unknown };

export interface JsonRpcMessage {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
}

/** One tool call's answer, as text for the model. */
export interface McpToolResult {
	text: string;
	isError?: boolean;
}

/**
 * A tools-only MCP server: what the JSON-RPC envelope in `dispatchMcpTools`
 * serves. The board tools here and the desktop's Lead chat tools are both one
 * of these, so the protocol handling exists once.
 */
export interface McpToolServer {
	info: { name: string; version: string };
	instructions: string;
	tools: readonly unknown[];
	/** Run one tool; null when there is no tool by that name. A throw becomes an
	 *  error result the model can read, not a protocol error. */
	call(name: string, args: Record<string, unknown>): Promise<McpToolResult | null>;
}

const ok = (id: JsonRpcMessage["id"], result: unknown): McpReply => ({
	kind: "json",
	body: { jsonrpc: "2.0", id, result },
});
const err = (id: JsonRpcMessage["id"], code: number, message: string): McpReply => ({
	kind: "json",
	body: { jsonrpc: "2.0", id, error: { code, message } },
});
const textContent = (text: string, isError = false) => ({
	content: [{ type: "text", text }],
	isError,
});

/** Dispatch one parsed JSON-RPC message against a tools-only MCP server. */
export async function dispatchMcpTools(
	msg: JsonRpcMessage,
	server: McpToolServer,
): Promise<McpReply> {
	const { method, id } = msg;

	// Notifications (no id) — acknowledge with 202, never a JSON-RPC reply.
	if (id == null && method?.startsWith("notifications/")) return { kind: "accepted" };

	switch (method) {
		case "initialize": {
			const clientVersion = (msg.params?.protocolVersion as string) ?? DEFAULT_PROTOCOL_VERSION;
			return ok(id, {
				protocolVersion: clientVersion,
				capabilities: { tools: { listChanged: false } },
				serverInfo: server.info,
				instructions: server.instructions,
			});
		}
		case "ping":
			return ok(id, {});
		case "tools/list":
			return ok(id, { tools: server.tools });
		case "tools/call": {
			const name = msg.params?.name as string | undefined;
			const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
			let res: McpToolResult | null;
			try {
				res = await server.call(name ?? "", args);
			} catch (e) {
				res = { text: `tool failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
			}
			if (!res) return err(id, -32602, `unknown tool: ${name}`);
			return ok(id, textContent(res.text, res.isError));
		}
		default:
			return err(id, -32601, `method not found: ${method}`);
	}
}

/** Dispatch one parsed JSON-RPC message against the board handlers. */
export function dispatchMcp(
	msg: JsonRpcMessage,
	board: BoardHandlers,
	ctx: McpContext = {},
): Promise<McpReply> {
	return dispatchMcpTools(msg, {
		info: SERVER_INFO,
		instructions: BOARD_INSTRUCTIONS,
		tools: TOOLS,
		call: (name, args) => callBoardTool(name, args, board, ctx),
	});
}

async function callBoardTool(
	name: string,
	args: Record<string, unknown>,
	board: BoardHandlers,
	ctx: McpContext,
): Promise<McpToolResult | null> {
	if (name === "get_board") {
		const view = await board.get();
		return { text: JSON.stringify(view, null, 2) };
	}
	if (name === "set_status") {
		const taskId = String(args.taskId ?? "");
		const to = String(args.to ?? "");
		const reason = args.reason != null ? String(args.reason) : undefined;
		if (!taskId || !to) return { text: "taskId and to are required", isError: true };
		const res = await board.setStatus({
			taskId,
			to,
			reason,
			callerTerminalId: ctx.callerTerminalId,
		});
		return { text: res.reason, isError: !res.ok };
	}
	if (name === "set_waiting") {
		const taskId = args.taskId != null ? String(args.taskId) : undefined;
		const reason = String(args.reason ?? "");
		const untilText = String(args.until ?? "");
		if (!reason || !untilText) return { text: "reason and until are required", isError: true };
		const until = parseUntil(untilText);
		if (until == null) {
			return { text: `until is not an ISO 8601 date: ${untilText}`, isError: true };
		}
		const res = await board.setWaiting({
			taskId,
			reason,
			until,
			callerTerminalId: ctx.callerTerminalId,
		});
		return { text: res.reason, isError: !res.ok };
	}
	if (name === "list_peers" || name === "send_message") {
		if (!ctx.callerTerminalId || !ctx.callerVerified) {
			return {
				text: "messaging is only open to an agent Ateam launched in a task (this session has no valid Ateam terminal token; relaunch it from Ateam)",
				isError: true,
			};
		}
		if (name === "list_peers") {
			const peers = await board.listPeers(ctx.callerTerminalId);
			return { text: JSON.stringify(peers, null, 2) };
		}
		const to = String(args.to ?? "");
		const body = String(args.message ?? "");
		if (!to || !body) return { text: "to and message are required", isError: true };
		const res = await board.sendMessage({ fromTerminalId: ctx.callerTerminalId, to, body });
		return { text: res.reason, isError: !res.ok };
	}
	return null;
}

/**
 * ISO 8601 → epoch ms, or null. A bare date ("2026-09-09") is read as 09:00
 * LOCAL time rather than UTC midnight: "check back on the 9th" means that
 * morning, not the small hours of the night before in every timezone west of
 * Greenwich.
 */
export function parseUntil(text: string): number | null {
	const t = text.trim();
	const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
	if (dateOnly) {
		const [, y, m, d] = dateOnly;
		const ms = new Date(Number(y), Number(m) - 1, Number(d), 9, 0, 0, 0).getTime();
		return Number.isFinite(ms) ? ms : null;
	}
	const ms = Date.parse(t);
	return Number.isFinite(ms) ? ms : null;
}
