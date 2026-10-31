// Newline-delimited JSON framing over any read+write stream pair — a duplex
// socket (readable === writable) or a child process's stdout+stdin (the SSH
// relay). The one framing implementation behind both socket and ssh transports.
import type { Readable, Writable } from "node:stream";
import type { ClientFrame, ClientTransport, ServerFrame } from "@ateam/protocol";
import type { ServerTransport } from "../rpc";

const NEWLINE = 0x0a;

/**
 * Each line, decoded once it is whole. A frame can run to megabytes (a file
 * sent to a box arrives as one line, in many chunks), so each chunk is searched
 * once and a line's chunks are joined once: growing one string and searching it
 * from the start on every chunk took 1.5 s for a 25 MB file, all of it with
 * every other frame on this connection waiting. Decoding whole lines also keeps
 * a character whose bytes straddle two chunks intact.
 */
function readLines(readable: Readable, onLine: (line: string) => void): void {
	// The bytes of the line not yet ended.
	let pending: Buffer[] = [];
	readable.on("data", (data: Buffer | string) => {
		let chunk = typeof data === "string" ? Buffer.from(data, "utf8") : data;
		let nl = chunk.indexOf(NEWLINE);
		while (nl !== -1) {
			pending.push(chunk.subarray(0, nl));
			const line = Buffer.concat(pending).toString("utf8");
			pending = [];
			if (line.trim()) onLine(line);
			chunk = chunk.subarray(nl + 1);
			nl = chunk.indexOf(NEWLINE);
		}
		if (chunk.length) pending.push(chunk);
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
