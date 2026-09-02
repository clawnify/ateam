// Claude Code's transcript store: ~/.claude/projects/<slugged-cwd>/<session>.jsonl,
// one JSONL line per event.
//
// We deliberately do NOT reproduce Claude's cwd→directory slug rule. It is
// undocumented, and a rule that drifts would silently return "no sessions"
// rather than fail loudly. Instead each directory is asked what cwd it holds by
// reading the `cwd` field off the FIRST BYTES of its first transcript, and the
// answer is remembered: a directory's cwd is what its name was derived from, so
// it cannot change under us.
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pushPrompt } from "../digest";
import type { SessionDigest, TranscriptSource } from "../types";
import { fileMemo, mtimeOf, readHead } from "./files";

const ROOT = () => join(homedir(), ".claude", "projects");

/** How much of a transcript is read to find its `cwd`. The field is on the
 *  session's first events; reading the whole file to reach them cost a
 *  gigabyte of I/O across 229 directories (1.3s) instead of 14MB (0.1s). */
const HEAD_BYTES = 64_000;

/** dir → cwd, for the life of the process. Misses are NOT remembered: a
 *  directory that is empty now holds the session you start next. */
const dirCwds = new Map<string, string>();

/** Read the `cwd` a project directory belongs to, from its first transcript. */
async function dirCwd(dir: string): Promise<string | null> {
	const known = dirCwds.get(dir);
	if (known) return known;
	let files: string[];
	try {
		files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return null;
	}
	for (const f of files.slice(0, 2)) {
		let head: string;
		try {
			head = await readHead(join(dir, f), HEAD_BYTES);
		} catch {
			continue;
		}
		for (const line of head.split("\n")) {
			if (!line.includes('"cwd"')) continue;
			try {
				const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
				if (typeof cwd === "string" && cwd) {
					dirCwds.set(dir, cwd);
					return cwd;
				}
			} catch {
				/* a truncated last line — keep looking */
			}
		}
	}
	return null;
}

/** Parse one transcript into a digest, or null if it holds no real prompts. */
export async function readClaudeTranscript(
	path: string,
	mtimeMs: number,
): Promise<SessionDigest | null> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return null;
	}
	const prompts: string[] = [];
	let cwd = "";
	let branch: string | null = null;
	let startedAt: number | null = null;
	let endedAt: number | null = null;
	let sessionId = "";
	for (const line of raw.split("\n")) {
		if (!line) continue;
		// Every transcript is mostly assistant/tool traffic; only user turns and
		// the session header matter, so skip the rest before paying for a parse.
		if (!line.includes('"type":"user"') && !sessionId) {
			if (!line.includes('"sessionId"')) continue;
		} else if (!line.includes('"type":"user"')) {
			continue;
		}
		let ev: Record<string, unknown>;
		try {
			ev = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (!sessionId && typeof ev.sessionId === "string") sessionId = ev.sessionId;
		// `isMeta` marks a user-role event the HARNESS injected, not something the
		// user typed: an expanded slash command, a skill body, a hook's output.
		// They are long, near-identical across sessions, and ranking them as
		// speech buried the real prompts under pasted skill documentation.
		if (ev.type !== "user" || ev.isSidechain || ev.isMeta) continue;
		if (typeof ev.sourceToolUseID === "string") continue;
		if (typeof ev.cwd === "string" && !cwd) cwd = ev.cwd;
		if (typeof ev.gitBranch === "string" && !branch) branch = ev.gitBranch;
		const ts = typeof ev.timestamp === "string" ? Date.parse(ev.timestamp) : Number.NaN;
		if (Number.isFinite(ts)) {
			startedAt ??= ts;
			endedAt = ts;
		}
		const message = ev.message as { content?: unknown } | undefined;
		pushPrompt(prompts, message?.content);
	}
	if (!sessionId || prompts.length === 0) return null;
	return { agentId: "claude", sessionId, cwd, branch, startedAt, endedAt, prompts, path, mtimeMs };
}

export function claudeSource(): TranscriptSource {
	const digests = fileMemo<SessionDigest | null>();
	return {
		agentId: "claude",
		async digestsFor(cwds) {
			const root = ROOT();
			const wanted = new Set(cwds);
			const out: SessionDigest[] = [];
			let dirs: string[];
			try {
				dirs = await readdir(root);
			} catch {
				return [];
			}
			for (const name of dirs) {
				const dir = join(root, name);
				const cwd = await dirCwd(dir);
				if (!cwd || !wanted.has(cwd)) continue;
				let files: string[];
				try {
					files = await readdir(dir);
				} catch {
					continue;
				}
				// One file at a time on purpose: a transcript can be tens of MB, and
				// reading a directory's worth in parallel would spike memory for no
				// gain — the awaits already keep the process responsive.
				for (const f of files) {
					if (!f.endsWith(".jsonl")) continue;
					const path = join(dir, f);
					const mtimeMs = await mtimeOf(path);
					if (mtimeMs === null) continue;
					const digest = await digests(path, mtimeMs, () => readClaudeTranscript(path, mtimeMs));
					// The directory maps to one cwd, but trust the transcript's own.
					if (digest && wanted.has(digest.cwd || cwd)) {
						out.push({ ...digest, cwd: digest.cwd || cwd });
					}
				}
			}
			return out;
		},
	};
}
