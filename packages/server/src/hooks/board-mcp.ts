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
}

/** Per-request context the HTTP layer derives (e.g. the caller's terminal id). */
export interface McpContext {
	callerTerminalId?: string;
}

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "ateam_board", version: "0.1.0" };

/** The two tools. `to` is constrained to the assignable columns to steer the
 *  model; the guardrail (validateSetStatus) still enforces it server-side. */
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
];

/** What the HTTP layer should send back. `accepted` → 202 no body (notifications). */
export type McpReply = { kind: "accepted" } | { kind: "json"; body: unknown };

interface JsonRpcMessage {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
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

/** Dispatch one parsed JSON-RPC message against the board handlers. */
export async function dispatchMcp(
	msg: JsonRpcMessage,
	board: BoardHandlers,
	ctx: McpContext = {},
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
				serverInfo: SERVER_INFO,
			});
		}
		case "ping":
			return ok(id, {});
		case "tools/list":
			return ok(id, { tools: TOOLS });
		case "tools/call":
			return callTool(msg, board, ctx);
		default:
			return err(id, -32601, `method not found: ${method}`);
	}
}

async function callTool(
	msg: JsonRpcMessage,
	board: BoardHandlers,
	ctx: McpContext,
): Promise<McpReply> {
	const { id } = msg;
	const name = msg.params?.name as string | undefined;
	const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
	try {
		if (name === "get_board") {
			const view = await board.get();
			return ok(id, textContent(JSON.stringify(view, null, 2)));
		}
		if (name === "set_status") {
			const taskId = String(args.taskId ?? "");
			const to = String(args.to ?? "");
			const reason = args.reason != null ? String(args.reason) : undefined;
			if (!taskId || !to) {
				return ok(id, textContent("taskId and to are required", true));
			}
			const res = await board.setStatus({
				taskId,
				to,
				reason,
				callerTerminalId: ctx.callerTerminalId,
			});
			return ok(id, textContent(res.reason, !res.ok));
		}
		return err(id, -32602, `unknown tool: ${name}`);
	} catch (e) {
		return ok(id, textContent(`tool failed: ${e instanceof Error ? e.message : String(e)}`, true));
	}
}
