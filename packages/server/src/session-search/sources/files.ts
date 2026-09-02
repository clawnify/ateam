/**
 * Filesystem helpers shared by the transcript sources.
 *
 * Both exist for the same reason: a transcript store is large (1GB+ on the
 * machine this was measured on) and almost entirely unchanged between searches.
 * So the two things worth never doing twice are reading a whole file to look at
 * its first lines, and parsing a file that has not moved since we last parsed
 * it. Everything is async: the engine shares a process with the window, and a
 * synchronous gigabyte of I/O is a frozen app.
 */
import { open, stat } from "node:fs/promises";

/** The first `bytes` of a file, as text. A tail cut mid-character, or a partial
 *  last line, is the caller's to tolerate — both only ever end a JSON line that
 *  fails to parse. */
export async function readHead(path: string, bytes: number): Promise<string> {
	const handle = await open(path, "r");
	try {
		const buf = Buffer.allocUnsafe(bytes);
		const { bytesRead } = await handle.read(buf, 0, bytes, 0);
		return buf.toString("utf8", 0, bytesRead);
	} finally {
		await handle.close();
	}
}

/**
 * The whole first line of a file, however long it is: read in chunks, stopping
 * at the first newline so a multi-megabyte body is never touched.
 *
 * A fixed byte budget is the wrong shape for a header line whose length is set
 * by someone else's format. Codex embeds its entire system prompt in that line
 * (~19KB today, and it grows with every release of Codex), so a budget that
 * fits today truncates later — and a truncated JSON line does not raise, it
 * just stops parsing, which surfaces as "that agent has no sessions at all".
 * The ceiling below only bounds a file that contains no newline whatsoever.
 */
const LINE_CEILING = 1_000_000;
const LINE_CHUNK = 64_000;

export async function readFirstLine(path: string): Promise<string> {
	const handle = await open(path, "r");
	try {
		const chunks: Buffer[] = [];
		let offset = 0;
		while (offset < LINE_CEILING) {
			const buf = Buffer.allocUnsafe(LINE_CHUNK);
			const { bytesRead } = await handle.read(buf, 0, LINE_CHUNK, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
			const read = buf.subarray(0, bytesRead);
			// Split on the byte, and decode only once at the end: a chunk boundary
			// lands mid-character often enough that per-chunk decoding corrupts it.
			const nl = read.indexOf(0x0a);
			if (nl !== -1) {
				chunks.push(read.subarray(0, nl));
				break;
			}
			chunks.push(read);
		}
		return Buffer.concat(chunks).toString("utf8");
	} finally {
		await handle.close();
	}
}

/** mtime of `path`, or null when it cannot be read. */
export async function mtimeOf(path: string): Promise<number | null> {
	try {
		return (await stat(path)).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * A per-file memo, invalidated by mtime. Transcripts are append-only, so a file
 * whose mtime has not moved parses to exactly what it parsed to last time: this
 * turns a rebuild from "re-read the whole history" into "re-read the session
 * you are still sitting in".
 *
 * Entries are bounded by the number of transcript files that belong to a task,
 * and each holds one digest — at most ~24KB, see the caps in digest.ts.
 */
export function fileMemo<T>(): (
	path: string,
	mtimeMs: number,
	compute: () => Promise<T>,
) => Promise<T> {
	const cache = new Map<string, { mtimeMs: number; value: T }>();
	return async (path, mtimeMs, compute) => {
		const hit = cache.get(path);
		if (hit && hit.mtimeMs === mtimeMs) return hit.value;
		const value = await compute();
		cache.set(path, { mtimeMs, value });
		return value;
	};
}
