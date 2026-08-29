// Claude Code's transcript store: ~/.claude/projects/<slugged-cwd>/<session>.jsonl,
// one JSONL line per event.
//
// We deliberately do NOT reproduce Claude's cwd→directory slug rule. It is
// undocumented, and a rule that drifts would silently return "no sessions"
// rather than fail loudly. Instead each directory is asked what cwd it holds by
// reading the `cwd` field off its first transcript — 0.15s for 200 directories,
// and correct whatever the slug rule does next.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pushPrompt } from "../digest";
import type { SessionDigest, TranscriptSource } from "../types";

const ROOT = () => join(homedir(), ".claude", "projects");

/** Read the `cwd` a project directory belongs to, from its first transcript. */
function dirCwd(dir: string): string | null {
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return null;
	}
	for (const f of files.slice(0, 2)) {
		let head: string;
		try {
			head = readFileSync(join(dir, f), "utf8").slice(0, 64_000);
		} catch {
			continue;
		}
		for (const line of head.split("\n")) {
			if (!line.includes('"cwd"')) continue;
			try {
				const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
				if (typeof cwd === "string" && cwd) return cwd;
			} catch {
				/* a truncated last line — keep looking */
			}
		}
	}
	return null;
}

/** Parse one transcript into a digest, or null if it holds no real prompts. */
export function readClaudeTranscript(path: string): SessionDigest | null {
	let raw: string;
	let mtimeMs: number;
	try {
		raw = readFileSync(path, "utf8");
		mtimeMs = statSync(path).mtimeMs;
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
	return {
		agentId: "claude",
		digestsFor(cwds) {
			const root = ROOT();
			if (!existsSync(root)) return [];
			const wanted = new Set(cwds);
			const out: SessionDigest[] = [];
			let dirs: string[];
			try {
				dirs = readdirSync(root);
			} catch {
				return [];
			}
			for (const name of dirs) {
				const dir = join(root, name);
				const cwd = dirCwd(dir);
				if (!cwd || !wanted.has(cwd)) continue;
				for (const f of readdirSync(dir)) {
					if (!f.endsWith(".jsonl")) continue;
					const digest = readClaudeTranscript(join(dir, f));
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
