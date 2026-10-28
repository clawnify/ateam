// The phone's WebSocket listener, kept from ever taking the engine down.
//
// The desktop reaches the engine over SSH whatever happens here, so a listener
// that can't come up must cost the phone alone. It used to exit the process, and
// on a box whose Tailscale runs in userspace mode (every boxd box) no interface
// owns the tailnet IP, so every engine started with that address died at once.
// The installer's own handshake engine was one of them: the install then failed
// before handing the engine to systemd, and the desktop's fallback connect started
// a plain one, with no listener, that stayed up for weeks.
//
// Instead it retries for as long as the engine runs. That also covers what exiting
// into a systemd restart used to: at boot the Tailscale address may not exist yet.
import { createServer, type Server, STATUS_CODES } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";

/** Waits between attempts; the last one repeats for the life of the engine. */
export const WS_RETRY_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000];

export function startWsListener(opts: {
	host: string;
	port: number;
	onConnection: (sock: WebSocket) => void;
	log: (line: string) => void;
	retryMs?: readonly number[];
}): { close(): void } {
	const retryMs = opts.retryMs ?? WS_RETRY_MS;
	let failures = 0;
	let closed = false;
	let current: Server | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	// The HTTP server is ours, not ws's: a WebSocketServer that owns its server
	// strips the server's error listener on close(), and Bun reports a failed bind
	// asynchronously, so closing during an attempt left that error uncaught.
	const wss = new WebSocketServer({ noServer: true });
	wss.on("connection", opts.onConnection);

	const listen = (): void => {
		// Plain HTTP gets the 426 ws's own server answered with.
		const server = createServer((_req, res) => {
			const body = STATUS_CODES[426] ?? "";
			res.writeHead(426, { "Content-Length": body.length, "Content-Type": "text/plain" });
			res.end(body);
		});
		current = server;
		server.on("upgrade", (req, sock, head) => {
			wss.handleUpgrade(req, sock, head, (ws) => wss.emit("connection", ws, req));
		});
		server.on("listening", () => {
			// A bind that lands after close() must not leave a server behind.
			if (closed) return void server.close();
			failures = 0;
			opts.log(`[ateam] daemon also listening on ws://${opts.host}:${opts.port}`);
		});
		server.on("error", (err: Error) => {
			if (closed) return;
			// Once per outage, not per attempt: a box that can never bind would
			// otherwise write a line every 30s forever.
			if (failures === 0) {
				opts.log(
					`[ateam] WS listener error: ${err.message}; retrying in the background (the desktop's SSH path is unaffected)`,
				);
			}
			server.close();
			const delay = retryMs[Math.min(failures, retryMs.length - 1)] ?? 30_000;
			failures++;
			timer = setTimeout(listen, delay);
			// A pending retry must never be what keeps the process alive.
			timer.unref?.();
		});
		server.listen(opts.port, opts.host);
	};
	listen();

	return {
		close() {
			closed = true;
			if (timer) clearTimeout(timer);
			current?.close();
			wss.close();
		},
	};
}
