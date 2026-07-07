// Server side of a WebSocket connection: one JSON frame per message. WebSocket is
// already message-framed, so — unlike socket.ts, which layers newline framing over
// a raw byte stream — there's nothing to delimit; each `message` IS one frame.
// This backs the daemon's opt-in WS listener (the phone's transport over Tailscale);
// the client half is @ateam/protocol's wsClientTransport, over the RN/browser global.

import type { ClientFrame, ServerFrame } from "@ateam/protocol";
import type { WebSocket } from "ws";
import type { ServerTransport } from "../rpc";

/** Adapt one `ws` connection to a ServerTransport for serveRpc. */
export function wsServerTransport(socket: WebSocket): ServerTransport {
	return {
		send(frame: ServerFrame) {
			socket.send(JSON.stringify(frame));
		},
		onFrame(handler) {
			socket.on("message", (data: unknown) => {
				try {
					handler(JSON.parse(String(data)) as ClientFrame);
				} catch {
					/* ignore malformed */
				}
			});
		},
		onClose(handler) {
			// close and error both mean the client is gone; ws fires 'close' after
			// 'error' anyway, so listening on 'close' alone frees the subscriptions once.
			socket.on("close", handler);
		},
	};
}
