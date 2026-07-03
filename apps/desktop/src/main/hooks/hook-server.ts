import { EventEmitter } from "node:events";
import http from "node:http";
import { type BoardHandlers, dispatchMcp } from "./board-mcp";

export type { BoardHandlers };

export interface HookEvent {
	terminalId: string;
	eventType: string;
	sessionId?: string;
}

/** An agent asked to merge (via the `gh` shim) — routed into the merge queue. */
export interface MergeRequestEvent {
	terminalId: string;
	strategy?: string;
}

/** Only localhost origins may reach the MCP endpoint (DNS-rebinding guard). */
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

/**
 * Tiny localhost HTTP server that agent hooks ping to report lifecycle events.
 * GET /hook/complete?terminalId=&eventType=&sessionId= → emits "hook".
 * GET /merge/request?terminalId=&strategy=          → emits "merge-request".
 * GET-with-query is trivial to emit from a shell hook with no JSON escaping.
 */
export class HookServer extends EventEmitter {
	private server?: http.Server;
	private board?: BoardHandlers;
	port = 0;

	/** Wire the Board Organizer's request/response tool handlers. */
	setBoardHandlers(handlers: BoardHandlers): void {
		this.board = handlers;
	}

	async start(preferred?: number): Promise<number> {
		this.server = http.createServer((req, res) => {
			const json = (status: number, body: unknown) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(body));
			};
			try {
				const url = new URL(req.url ?? "/", "http://127.0.0.1");

				// MCP endpoint (Streamable HTTP). Both the organizer loop and a
				// task's own session reach the board tools here; the caller's
				// terminal id (header) is what distinguishes a self-move.
				if (url.pathname === "/mcp") {
					if (req.method !== "POST") {
						res.writeHead(405);
						res.end();
						return;
					}
					const origin = req.headers.origin;
					if (origin && !LOCAL_ORIGIN.test(origin)) {
						res.writeHead(403);
						res.end();
						return;
					}
					if (!this.board) return json(503, { error: "board handlers not ready" });
					const board = this.board;
					const callerTerminalId =
						(req.headers["x-ateam-terminal-id"] as string | undefined) || undefined;
					let body = "";
					req.on("data", (c) => {
						body += c;
						if (body.length > 1_000_000) req.destroy();
					});
					req.on("end", () => {
						let msg: unknown;
						try {
							msg = JSON.parse(body);
						} catch {
							return json(400, {
								jsonrpc: "2.0",
								id: null,
								error: { code: -32700, message: "parse error" },
							});
						}
						dispatchMcp(msg as Parameters<typeof dispatchMcp>[0], board, { callerTerminalId })
							.then((reply) => {
								if (reply.kind === "accepted") {
									res.writeHead(202);
									res.end();
								} else {
									json(200, reply.body);
								}
							})
							.catch((e) =>
								json(500, {
									jsonrpc: "2.0",
									id: null,
									error: { code: -32603, message: String(e) },
								}),
							);
					});
					return;
				}

				// Board tools as plain GET (debug / non-MCP clients). The MCP
				// endpoint above is the path agents actually use.
				if (req.method === "GET" && url.pathname === "/board/get") {
					if (!this.board) return json(503, { error: "board handlers not ready" });
					this.board
						.get()
						.then((view) => json(200, view))
						.catch((e) => json(500, { error: String(e) }));
					return;
				}
				if (req.method === "GET" && url.pathname === "/board/set-status") {
					const taskId = url.searchParams.get("taskId") ?? "";
					const to = url.searchParams.get("to") ?? "";
					const reason = url.searchParams.get("reason") ?? undefined;
					const callerTerminalId = url.searchParams.get("terminalId") ?? undefined;
					if (!this.board) return json(503, { error: "board handlers not ready" });
					if (!taskId || !to) return json(400, { ok: false, reason: "taskId and to required" });
					this.board
						.setStatus({ taskId, to, reason, callerTerminalId })
						.then((r) => json(200, r))
						.catch((e) => json(500, { ok: false, reason: String(e) }));
					return;
				}
				if (req.method === "GET" && url.pathname === "/hook/complete") {
					const terminalId = url.searchParams.get("terminalId") ?? "";
					const eventType = url.searchParams.get("eventType") ?? "";
					const sessionId = url.searchParams.get("sessionId") ?? undefined;
					if (terminalId && eventType) {
						this.emit("hook", {
							terminalId,
							eventType,
							sessionId,
						} satisfies HookEvent);
					}
					res.writeHead(204);
					res.end();
					return;
				}
				if (req.method === "GET" && url.pathname === "/merge/request") {
					const terminalId = url.searchParams.get("terminalId") ?? "";
					const strategy = url.searchParams.get("strategy") ?? undefined;
					if (terminalId) {
						this.emit("merge-request", {
							terminalId,
							strategy,
						} satisfies MergeRequestEvent);
						res.writeHead(202);
						res.end();
						return;
					}
					res.writeHead(400);
					res.end();
					return;
				}
				res.writeHead(404);
				res.end();
			} catch {
				res.writeHead(400);
				res.end();
			}
		});

		// Prefer the port persisted from the previous run so agents that survived
		// an app restart (their env still points at the old port) keep reporting
		// status. Fall back to an ephemeral port if it's taken.
		const tryListen = (port: number) =>
			new Promise<boolean>((resolve) => {
				const srv = this.server;
				if (!srv) return resolve(false);
				const onError = () => {
					srv.removeListener("listening", onListening);
					resolve(false);
				};
				const onListening = () => {
					srv.removeListener("error", onError);
					resolve(true);
				};
				srv.once("error", onError);
				srv.once("listening", onListening);
				srv.listen(port, "127.0.0.1");
			});

		let bound = false;
		if (preferred && preferred > 0) bound = await tryListen(preferred);
		if (!bound) bound = await tryListen(0);
		if (!bound) throw new Error("hook server could not bind to a port");

		const addr = this.server.address();
		this.port = typeof addr === "object" && addr ? addr.port : 0;
		return this.port;
	}

	stop(): void {
		this.server?.close();
	}
}
