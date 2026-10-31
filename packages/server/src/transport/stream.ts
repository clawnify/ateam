// Newline-delimited JSON framing over any read+write stream pair — a duplex
// socket (readable === writable) or a child process's stdout+stdin (the SSH
// relay). The one framing implementation behind both socket and ssh transports.
import type { Readable, Writable } from "node:stream";
import type { ClientFrame, ClientTransport, ServerFrame } from "@ateam/protocol";
import type { ServerTransport } from "../rpc";

const NEWLINE = 0x0a;

/**
 * Each line, decoded once it is whole. A frame can run to megabytes (a file
 * sent to a box arrives as one line, in many chunks), so a chunk with no
 * newline is only kept, and the kept chunks are joined once when the line
 * ends: growing one string and searching it from the start on every chunk took
 * 1.5 s for a 25 MB file, all of it with every other frame on this connection
 * waiting. Most chunks instead carry many small frames (terminal output), so a
 * chunk is decoded once, up to its last newline, and then split: joining and
 * decoding each line on its own was about 5x slower for 80-byte frames. A
 * newline byte is never part of a UTF-8 character, so a character whose bytes
 * straddle two chunks stays intact.
 */
function readLines(readable: Readable, onLine: (line: string) => void): void {
	// The bytes after the last newline, the start of a line not yet ended.
	let pending: Buffer[] = [];
	readable.on("data", (data: Buffer | string) => {
		const chunk = typeof data === "string" ? Buffer.from(data, "utf8") : data;
		const last = chunk.lastIndexOf(NEWLINE);
		if (last === -1) {
			pending.push(chunk);
			return;
		}
		const head = chunk.subarray(0, last);
		const text = (pending.length ? Buffer.concat([...pending, head]) : head).toString("utf8");
		pending = last + 1 < chunk.length ? [chunk.subarray(last + 1)] : [];
		for (const line of text.split("\n")) if (line.trim()) onLine(line);
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
