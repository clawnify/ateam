import { EventEmitter } from "node:events";
import http from "node:http";
import { describeMergeResult, type MergeEnqueueDTO } from "@ateam/protocol";
import { type BoardHandlers, dispatchMcp } from "./board-mcp";

export type { BoardHandlers };

export interface HookEvent {
	terminalId: string;
	eventType: string;
	sessionId?: string;
	/** Stop: the agent's final message of the turn, when its hook sent one. */
	lastAssistantMessage?: string;
	/** UserReply: what the user typed. */
	prompt?: string;
}

/** Longest text kept from a hook body; a turn's closing message is well inside it. */
const MAX_HOOK_TEXT = 20_000;

/**
 * The text a hook's JSON input carries, by agent: Claude Code and Codex hooks
 * send `last_assistant_message` on Stop and `prompt` on UserPromptSubmit (both
 * documented schemas); Codex's `notify` program sends the hyphenated
 * `last-assistant-message` and `input-messages`. Anything else, or a body that
 * is not JSON, yields nothing, and the event is exactly what it was before.
 */
export function hookText(body: string): Pick<HookEvent, "lastAssistantMessage" | "prompt"> {
	if (!body) return {};
	let raw: unknown;
	try {
		raw = JSON.parse(body);
	} catch {
		return {};
	}
	if (!raw || typeof raw !== "object") return {};
	const o = raw as Record<string, unknown>;
	const str = (v: unknown) =>
		typeof v === "string" && v.trim() ? v.slice(0, MAX_HOOK_TEXT) : undefined;
	const inputs = o["input-messages"];
	const lastInput = Array.isArray(inputs) ? inputs[inputs.length - 1] : undefined;
	const out: Pick<HookEvent, "lastAssistantMessage" | "prompt"> = {};
	const last = str(o.last_assistant_message) ?? str(o["last-assistant-message"]);
	const prompt = str(o.prompt) ?? str(lastInput);
	if (last) out.lastAssistantMessage = last;
	if (prompt) out.prompt = prompt;
	return out;
}

/** An agent asked to merge (via the `gh` shim) — routed into the merge queue. */
export interface MergeRequestEvent {
	terminalId: string;
	strategy?: string;
}

/**
 * Runs an agent's merge request through the queue and resolves with its
 * outcome, or null when the terminal belongs to no task (the shim then falls
 * back to the real `gh`).
 */
export type MergeHandler = (e: MergeRequestEvent) => Promise<MergeEnqueueDTO | null>;

/**
 * Asks whether a finished turn should be continued with a follow-up prompt.
 * Returning text turns the agent's own `Stop` into another turn; returning
 * undefined lets it stop. Consuming is the resolver's job (see `FollowUps`).
 */
export type FollowUpResolver = (terminalId: string, eventType: string) => string | undefined;

/** Only localhost origins may reach the MCP endpoint (DNS-rebinding guard). */
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

/**
 * Tiny localhost HTTP server that agent hooks ping to report lifecycle events.
 * GET /hook/complete?terminalId=&eventType=&sessionId= → emits "hook".
 * GET /merge/request?terminalId=&strategy=          → answers once the merge
 *   settles: 200 merged, 409 not merged (the body says why), 404 no such task.
 * GET-with-query is trivial to emit from a shell hook with no JSON escaping.
 */
export class HookServer extends EventEmitter {
	private server?: http.Server;
	private board?: BoardHandlers;
	private followUp?: FollowUpResolver;
	private merge?: MergeHandler;
	port = 0;

	/** Wire the Board Organizer's request/response tool handlers. */
	setBoardHandlers(handlers: BoardHandlers): void {
		this.board = handlers;
	}

	/** Wire the merge queue behind the gh shim's `/merge/request`. */
	setMergeHandler(handler: MergeHandler): void {
		this.merge = handler;
	}

	/** Wire the one-shot follow-up lookup consulted at every turn end. */
	setFollowUpResolver(resolve: FollowUpResolver): void {
		this.followUp = resolve;
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
				// GET from every hook; POST, with the hook's own JSON input as the
				// body, from the two that carry text (see notify.sh).
				if (
					(req.method === "GET" || req.method === "POST") &&
					url.pathname === "/hook/complete"
				) {
					const complete = (body: string) => {
						const terminalId = url.searchParams.get("terminalId") ?? "";
						const eventType = url.searchParams.get("eventType") ?? "";
						const sessionId = url.searchParams.get("sessionId") ?? undefined;
						if (terminalId && eventType) {
							this.emit("hook", {
								terminalId,
								eventType,
								sessionId,
								...hookText(body),
							} satisfies HookEvent);
						}
						// A turn that ends with a follow-up armed continues instead of
						// stopping: this body IS the agent's Stop-hook output, echoed
						// straight back by notify.sh. Every other request keeps the
						// empty 204 it has always returned, so a session without a
						// follow-up behaves exactly as before.
						const followUp = terminalId ? this.followUp?.(terminalId, eventType) : undefined;
						if (followUp) {
							return json(200, { decision: "block", reason: followUp });
						}
						res.writeHead(204);
						res.end();
					};
					if (req.method === "GET") return complete("");
					let body = "";
					let tooBig = false;
					req.on("data", (c) => {
						if (tooBig) return;
						body += c;
						// A turn's text, not a transcript. Past this the text is
						// dropped and the event still lands, bodiless.
						if (body.length > 1_000_000) {
							tooBig = true;
							body = "";
						}
					});
					req.on("end", () => complete(body));
					return;
				}
				if (req.method === "GET" && url.pathname === "/merge/request") {
					const terminalId = url.searchParams.get("terminalId") ?? "";
					const strategy = url.searchParams.get("strategy") ?? undefined;
					if (!terminalId) {
						res.writeHead(400);
						res.end();
						return;
					}
					if (!this.merge) {
						res.writeHead(503);
						res.end();
						return;
					}
					// Held open until the merge settles, so the agent that asked reads
					// the real outcome (conflicts included) instead of "queued".
					const text = (status: number, body: string) => {
						res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
						res.end(`${body}\n`);
					};
					this.merge({ terminalId, strategy }).then(
						(r) => {
							if (!r) return text(404, "Ateam: this terminal belongs to no task.");
							text(r.ok ? 200 : 409, describeMergeResult(r));
						},
						(err) =>
							text(500, `Ateam: merge failed: ${err instanceof Error ? err.message : String(err)}`),
					);
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
