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
	let current: WebSocketServer | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const listen = (): void => {
		const wss = new WebSocketServer({ host: opts.host, port: opts.port });
		current = wss;
		wss.on("connection", opts.onConnection);
		wss.on("listening", () => {
			failures = 0;
			opts.log(`[ateam] daemon also listening on ws://${opts.host}:${opts.port}`);
		});
		wss.on("error", (err: Error) => {
			// Once per outage, not per attempt: a box that can never bind would
			// otherwise write a line every 30s forever.
			if (failures === 0) {
				opts.log(
					`[ateam] WS listener error: ${err.message}; retrying in the background (the desktop's SSH path is unaffected)`,
				);
			}
			wss.close();
			if (closed) return;
			const delay = retryMs[Math.min(failures, retryMs.length - 1)] ?? 30_000;
			failures++;
			timer = setTimeout(listen, delay);
			// A pending retry must never be what keeps the process alive.
			timer.unref?.();
		});
	};
	listen();

	return {
		close() {
			closed = true;
			if (timer) clearTimeout(timer);
			current?.close();
		},
	};
}
