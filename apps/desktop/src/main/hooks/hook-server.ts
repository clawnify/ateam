import { EventEmitter } from "node:events";
import http from "node:http";

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

/**
 * Tiny localhost HTTP server that agent hooks ping to report lifecycle events.
 * GET /hook/complete?terminalId=&eventType=&sessionId= → emits "hook".
 * GET /merge/request?terminalId=&strategy=          → emits "merge-request".
 * GET-with-query is trivial to emit from a shell hook with no JSON escaping.
 */
export class HookServer extends EventEmitter {
	private server?: http.Server;
	port = 0;

	async start(preferred?: number): Promise<number> {
		this.server = http.createServer((req, res) => {
			try {
				const url = new URL(req.url ?? "/", "http://127.0.0.1");
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
