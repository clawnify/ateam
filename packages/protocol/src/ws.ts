// A ClientTransport over the platform-global WebSocket — the one built into the
// browser, React Native, and Bun alike. Dependency-free and DOM-lib-free: it
// depends only on the tiny structural subset below and reads the constructor off
// globalThis, so it runs in the desktop renderer, a PWA, and the Expo mobile app
// with no `ws` package and no node `net`. This is the transport the phone uses to
// reach a box's opt-in WS listener over Tailscale (see @ateam/server's cli.ts).
//
// WebSocket is already message-framed, so — unlike the stdio/socket transports —
// there is no newline framing: one JSON frame per message.
import type { ClientFrame, ClientTransport, ServerFrame } from "./rpc";

/** The minimal WebSocket surface we use; every platform's global satisfies it. */
interface MinimalWebSocket {
	send(data: string): void;
	close(): void;
	onopen: (() => void) | null;
	onclose: (() => void) | null;
	onerror: (() => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
}
type WebSocketCtor = new (url: string) => MinimalWebSocket;

export interface WsClient {
	transport: ClientTransport;
	/** Close the socket; fires the transport's onClose so in-flight calls reject. */
	close(): void;
}

/**
 * Open an RPC transport to `url` (e.g. `ws://100.x.y.z:PORT` — the box's Tailscale
 * address). Frames sent before the socket is OPEN are queued and flushed on open,
 * so the connect-time `system:hello` handshake is never dropped.
 */
export function wsClientTransport(url: string): WsClient {
	const Ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
	if (!Ctor) throw new Error("no global WebSocket on this platform");
	const ws = new Ctor(url);

	let open = false;
	let closed = false;
	const queue: string[] = [];
	const closeHandlers: (() => void)[] = [];
	let frameHandler: ((frame: ServerFrame) => void) | null = null;

	ws.onopen = () => {
		open = true;
		for (const msg of queue) ws.send(msg);
		queue.length = 0;
	};
	ws.onmessage = (event) => {
		if (!frameHandler) return;
		try {
			frameHandler(JSON.parse(String(event.data)) as ServerFrame);
		} catch {
			/* ignore malformed */
		}
	};
	// close and error both mean "channel gone"; fire the handlers exactly once.
	const fireClosed = () => {
		if (closed) return;
		closed = true;
		for (const h of closeHandlers) h();
	};
	ws.onclose = fireClosed;
	ws.onerror = fireClosed;

	return {
		transport: {
			send(frame: ClientFrame) {
				const msg = JSON.stringify(frame);
				if (open) ws.send(msg);
				else queue.push(msg);
			},
			onFrame(handler) {
				frameHandler = handler;
			},
			onClose(handler) {
				closeHandlers.push(handler);
			},
		},
		close: () => ws.close(),
	};
}
