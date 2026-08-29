// Codex's transcript store: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
//
// Sharded by DATE, not by cwd, so there is no directory to look up: the session
// header (`session_meta`, always the first line) carries the cwd. Reading one
// line per file is what keeps a whole-history scan cheap.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pushPrompt } from "../digest";
import type { SessionDigest, TranscriptSource } from "../types";

const ROOT = () => join(homedir(), ".codex", "sessions");

/** Every rollout file under the date-sharded tree. */
function rolloutFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, depth: number) => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(dir, e.name);
			// YYYY/MM/DD — three levels of directories, then the files.
			if (e.isDirectory() && depth < 3) walk(p, depth + 1);
			else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
		}
	};
	walk(root, 0);
	return out;
}

/** The cwd a rollout ran in, from its `session_meta` header line. */
function headerCwd(path: string, head: string): { sessionId: string; cwd: string } | null {
	for (const line of head.split("\n")) {
		if (!line.includes('"session_meta"')) continue;
		try {
			const payload = (JSON.parse(line) as { payload?: { id?: string; cwd?: string } }).payload;
			if (payload?.cwd) return { sessionId: payload.id ?? path, cwd: payload.cwd };
		} catch {
			return null;
		}
	}
	return null;
}

export function readCodexRollout(path: string, wanted: Set<string>): SessionDigest | null {
	let raw: string;
	let mtimeMs: number;
	try {
		// The header is the first line; read it before paying for the whole file.
		raw = readFileSync(path, "utf8");
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		return null;
	}
	const header = headerCwd(path, raw.slice(0, 8_000));
	if (!header || !wanted.has(header.cwd)) return null;
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

export function codexSource(): TranscriptSource {
	return {
		agentId: "codex",
		digestsFor(cwds) {
			const root = ROOT();
			if (!existsSync(root)) return [];
			const wanted = new Set(cwds);
			const out: SessionDigest[] = [];
			for (const f of rolloutFiles(root)) {
				const d = readCodexRollout(f, wanted);
				if (d) out.push(d);
			}
			return out;
		},
	};
}
