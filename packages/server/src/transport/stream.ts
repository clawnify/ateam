// Newline-delimited JSON framing over any read+write stream pair — a duplex
// socket (readable === writable) or a child process's stdout+stdin (the SSH
// relay). The one framing implementation behind both socket and ssh transports.
import type { Readable, Writable } from "node:stream";
import type { ClientFrame, ClientTransport, ServerFrame } from "@ateam/protocol";
import type { ServerTransport } from "../rpc";

function readLines(readable: Readable, onLine: (line: string) => void): void {
	let buf = "";
	readable.on("data", (chunk: Buffer | string) => {
		buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		let nl: number;
		// biome-ignore lint/suspicious/noAssignInExpressions: stream framing
		while ((nl = buf.indexOf("\n")) !== -1) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (line.trim()) onLine(line);
		}
	});
}

/** Fire `handler` once, on the first close/error of either stream. */
function onceClosed(readable: Readable, writable: Writable, handler: () => void): void {
	let done = false;
	const fire = () => {
		if (done) return;
		done = true;
		handler();
	};
	readable.on("close", fire);
	readable.on("error", fire);
	writable.on("close", fire);
	writable.on("error", fire);
}

/** Server side: reads ClientFrames, writes ServerFrames. */
export function streamServerTransport(readable: Readable, writable: Writable): ServerTransport {
	return {
		send(frame: ServerFrame) {
			writable.write(`${JSON.stringify(frame)}\n`);
		},
		onFrame(handler) {
			readLines(readable, (line) => {
				try {
					handler(JSON.parse(line) as ClientFrame);
				} catch {
					/* ignore malformed */
				}
			});
		},
		onClose(handler) {
			onceClosed(readable, writable, handler);
		},
	};
}

/** Client side: writes ClientFrames, reads ServerFrames. */
export function streamClientTransport(readable: Readable, writable: Writable): ClientTransport {
	return {
		send(frame: ClientFrame) {
			writable.write(`${JSON.stringify(frame)}\n`);
		},
		onFrame(handler) {
			readLines(readable, (line) => {
				try {
					handler(JSON.parse(line) as ServerFrame);
				} catch {
					/* ignore malformed */
				}
			});
		},
		onClose(handler) {
			onceClosed(readable, writable, handler);
		},
	};
}
