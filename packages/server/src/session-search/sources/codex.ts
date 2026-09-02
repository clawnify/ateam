// Codex's transcript store: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
//
// Sharded by DATE, not by cwd, so there is no directory to look up: the session
// header (`session_meta`, always the first line) carries the cwd. Reading that
// line ALONE is what keeps a whole-history scan cheap — a rollout that ran in
// some other repo must never cost more than the one line that says so, rather
// than the megabytes behind it.
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pushPrompt } from "../digest";
import type { SessionDigest, TranscriptSource } from "../types";
import { fileMemo, mtimeOf, readFirstLine } from "./files";

const ROOT = () => join(homedir(), ".codex", "sessions");

interface Header {
	sessionId: string;
	cwd: string;
}

/** Every rollout file under the date-sharded tree. */
async function rolloutFiles(root: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (dir: string, depth: number) => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(dir, e.name);
			// YYYY/MM/DD — three levels of directories, then the files.
			if (e.isDirectory() && depth < 3) await walk(p, depth + 1);
			else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
		}
	};
	await walk(root, 0);
	return out;
}

/** The cwd a rollout ran in, from its `session_meta` header line. */
function parseHeader(path: string, line: string): Header | null {
	if (!line.includes('"session_meta"')) return null;
	try {
		const payload = (JSON.parse(line) as { payload?: { id?: string; cwd?: string } }).payload;
		if (payload?.cwd) return { sessionId: payload.id ?? path, cwd: payload.cwd };
	} catch {
		/* not a header we can read — the rollout is skipped */
	}
	return null;
}

export async function readCodexRollout(
	path: string,
	mtimeMs: number,
	header: Header,
): Promise<SessionDigest | null> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return null;
	}
	const prompts: string[] = [];
	let startedAt: number | null = null;
	let endedAt: number | null = null;
	for (const line of raw.split("\n")) {
		if (!line.includes('"role":"user"')) continue;
		let ev: { timestamp?: string; payload?: { role?: string; content?: unknown } };
		try {
			ev = JSON.parse(line);
		} catch {
			continue;
		}
		if (ev.payload?.role !== "user") continue;
		const ts = ev.timestamp ? Date.parse(ev.timestamp) : Number.NaN;
		if (Number.isFinite(ts)) {
			startedAt ??= ts;
			endedAt = ts;
		}
		// Codex blocks are {type:"input_text", text}, which contentText handles.
		pushPrompt(prompts, ev.payload.content);
	}
	if (prompts.length === 0) return null;
	return {
		agentId: "codex",
		sessionId: header.sessionId,
		cwd: header.cwd,
		branch: null, // Codex records no branch; the task's branch stands in.
		startedAt,
		endedAt,
		prompts,
		path,
		mtimeMs,
	};
}

/** `root` exists so the tests can point at a fixture store: Bun's `os.homedir()`
 *  ignores `$HOME`, so there is no other seam to stand a fake rollout in. */
export function codexSource(root = ROOT()): TranscriptSource {
	// Two memos, because they answer different questions at different prices:
	// which repo a rollout belongs to (one line), and what it said (the whole
	// file, up to 7.6MB on this machine).
	// Neither depends on which project is searching, so both are safe to share
	// across projects.
	const headers = fileMemo<Header | null>();
	const digests = fileMemo<SessionDigest | null>();
	return {
		agentId: "codex",
		async digestsFor(cwds) {
			const wanted = new Set(cwds);
			const out: SessionDigest[] = [];
			for (const path of await rolloutFiles(root)) {
				const mtimeMs = await mtimeOf(path);
				if (mtimeMs === null) continue;
				const header = await headers(path, mtimeMs, async () =>
					parseHeader(path, await readFirstLine(path).catch(() => "")),
				);
				if (!header || !wanted.has(header.cwd)) continue;
				const digest = await digests(path, mtimeMs, () => readCodexRollout(path, mtimeMs, header));
				if (digest) out.push(digest);
			}
			return out;
		},
	};
}
