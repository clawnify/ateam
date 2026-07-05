// Newline-delimited JSON framing over a net.Socket — the wire the ateam daemon
// speaks to local clients and through the `attach --stdio` relay. Same framing
// the PTY daemon and PtyClient already use: one JSON object per line.
import type { Socket } from "node:net";
import type { ClientFrame, ClientTransport, ServerFrame } from "@ateam/protocol";
import type { ServerTransport } from "../rpc";

function readLines(socket: Socket, onLine: (line: string) => void): void {
	let buf = "";
	socket.on("data", (chunk) => {
		buf += chunk.toString("utf8");
		let nl: number;
		// biome-ignore lint/suspicious/noAssignInExpressions: stream framing
		while ((nl = buf.indexOf("\n")) !== -1) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (line.trim()) onLine(line);
		}
	});
}

/** Fire `handler` exactly once, on the socket's first close or error. */
function onceClosed(socket: Socket, handler: () => void): void {
	let done = false;
	const fire = () => {
		if (done) return;
		done = true;
		handler();
	};
	socket.on("close", fire);
	socket.on("error", fire);
}

/** Server side of a socket connection: receives ClientFrames, sends ServerFrames. */
export function socketServerTransport(socket: Socket): ServerTransport {
	return {
		send(frame: ServerFrame) {
			socket.write(`${JSON.stringify(frame)}\n`);
		},
		onFrame(handler) {
			readLines(socket, (line) => {
				try {
					handler(JSON.parse(line) as ClientFrame);
				} catch {
					/* ignore malformed */
				}
			});
		},
		onClose(handler) {
			onceClosed(socket, handler);
		},
	};
}

/** Client side of a socket connection: sends ClientFrames, receives ServerFrames. */
export function socketClientTransport(socket: Socket): ClientTransport {
	return {
		send(frame: ClientFrame) {
			socket.write(`${JSON.stringify(frame)}\n`);
		},
		onFrame(handler) {
			readLines(socket, (line) => {
				try {
					handler(JSON.parse(line) as ServerFrame);
				} catch {
					/* ignore malformed */
				}
			});
		},
		onClose(handler) {
			onceClosed(socket, handler);
		},
	};
}
