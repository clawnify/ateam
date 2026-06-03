import { EventEmitter } from "node:events";
import http from "node:http";

export interface HookEvent {
	terminalId: string;
	eventType: string;
	sessionId?: string;
}

/**
 * Tiny localhost HTTP server that agent hooks ping to report lifecycle events.
 * GET /hook/complete?terminalId=&eventType=&sessionId= → emits "hook".
 * GET-with-query is trivial to emit from a shell hook with no JSON escaping.
 */
export class HookServer extends EventEmitter {
	private server?: http.Server;
	port = 0;

	async start(): Promise<number> {
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
				res.writeHead(404);
				res.end();
			} catch {
				res.writeHead(400);
				res.end();
			}
		});

		await new Promise<void>((resolve) => {
			this.server?.listen(0, "127.0.0.1", resolve);
		});
		const addr = this.server.address();
		this.port = typeof addr === "object" && addr ? addr.port : 0;
		return this.port;
	}

	stop(): void {
		this.server?.close();
	}
}
