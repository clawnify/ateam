/**
 * Stage two of the search: hand the shortlist to a model and let it pick.
 *
 * The model is reached through the agent registry's `headless` invocation, not
 * through `claude -p` directly — whichever agent the user runs is the one that
 * answers. All this module needs back is text; the JSON inside it is extracted
 * defensively, because every one of these CLIs may wrap an answer in a fence or
 * a sentence, and a re-rank that throws must degrade to the lexical order
 * rather than to an error.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgent } from "@ateam/agents";
import { shell } from "../sessions";
import type { RankedSession } from "./types";

/** The model's verdict on one candidate. */
export interface Verdict {
	sessionId: string;
	/** One sentence on why this session is the answer, in the user's own words. */
	why: string;
	confidence: "high" | "medium" | "low";
}

const CONFIDENCE = new Set(["high", "medium", "low"]);

/** Pull the first JSON object out of a reply that may be fenced or prefaced. */
export function extractJson(text: string): unknown {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = fenced?.[1] ?? text;
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	try {
		return JSON.parse(body.slice(start, end + 1));
	} catch {
		return null;
	}
}

/** Validate the model's reply into verdicts, dropping anything malformed or
 *  hallucinated (an id that was never a candidate). */
export function parseVerdicts(text: string, candidateIds: Set<string>): Verdict[] {
	const parsed = extractJson(text) as { results?: unknown } | null;
	if (!parsed || !Array.isArray(parsed.results)) return [];
	const out: Verdict[] = [];
	for (const r of parsed.results) {
		if (!r || typeof r !== "object") continue;
		const { id, why, confidence } = r as Record<string, unknown>;
		if (typeof id !== "string" || !candidateIds.has(id)) continue;
		if (out.some((v) => v.sessionId === id)) continue;
		out.push({
			sessionId: id,
			why: typeof why === "string" ? why.slice(0, 240) : "",
			confidence:
				typeof confidence === "string" && CONFIDENCE.has(confidence)
					? (confidence as Verdict["confidence"])
					: "low",
		});
	}
	return out;
}

/** The prompt: the shortlist, and one instruction. Kept in one function so the
 *  shape is visible and testable rather than smeared through the caller. */
export function buildPrompt(
	query: string,
	candidates: RankedSession[],
	labels: Map<string, string>,
): string {
	const lines = candidates.map((c) => {
		const when = c.digest.endedAt
			? new Date(c.digest.endedAt).toISOString().slice(0, 10)
			: "unknown date";
		const label = labels.get(c.digest.sessionId) ?? c.digest.branch ?? "";
		return [
			`### ${c.digest.sessionId}`,
			`task: ${label} | agent: ${c.digest.agentId} | ${when}`,
			// Two trimmed excerpts, not four full ones: this prompt is on the path
			// of a click, and every token here is latency the user waits through.
			...c.excerpts.slice(0, 2).map((e) => `- ${e.slice(0, 200)}`),
		].join("\n");
	});
	return [
		"You are searching someone's own past coding sessions to answer: which session was this?",
		"",
		`QUESTION: ${query}`,
		"",
		"Below are candidate sessions, each with the user's own messages from it.",
		"Pick the ones that actually match the question. Prefer a short, precise answer:",
		"return nothing rather than a session you do not believe in.",
		"",
		'Reply with JSON only, nothing before or after it: {"results":[{"id":"<session id>","why":"<max 15 words, quoting the user\'s own words>","confidence":"high|medium|low"}]}',
		"Order best first, at most 5.",
		"",
		"--- CANDIDATES ---",
		...lines,
	].join("\n");
}

/**
 * Ask the model for other words the user might actually have typed.
 *
 * This is what makes "describe the work" work at all. Retrieval is lexical, so
 * a question phrased in today's words ("the phone asked for consent before
 * connecting") matches nothing in a session that said "ask before the first
 * connection on mobile" — the shortlist comes back empty and the re-rank never
 * runs. Expanding the query first is the cheap, embedding-free fix: one small
 * call, and the terms it returns are searched alongside the user's own.
 */
export async function expandQuery(agentId: string, query: string): Promise<string[]> {
	const prompt = [
		"Someone is searching their own past coding sessions by describing the work.",
		"List other words and short phrases they plausibly typed AT THE TIME, including",
		"likely code, file, branch and UI vocabulary for it. No explanations.",
		"",
		`THEIR DESCRIPTION: ${query}`,
		"",
		'Reply with JSON only: {"terms":["...", "..."]} — at most 12, each 1-3 words.',
	].join("\n");
	const parsed = extractJson(await askAgent(agentId, prompt, EXPAND_TIMEOUT_MS)) as {
		terms?: unknown;
	} | null;
	if (!parsed || !Array.isArray(parsed.terms)) return [];
	return parsed.terms
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter((t) => t.length > 1)
		.slice(0, 12);
}

/** Expansion is on the path of a click, and a slow one is worse than none. */
const EXPAND_TIMEOUT_MS = 20_000;

/** How long the model gets before the search falls back to the lexical order. */
const TIMEOUT_MS = 45_000;

/** Quote one argument for the login shell. */
function q(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run one headless turn on `agentId`. Resolves to "" on any failure — the
 * caller treats an empty reply as "no opinion" and keeps its own ordering.
 *
 * Launched through a LOGIN shell, exactly as an interactive agent session is
 * (see sessions.ts). A GUI app inherits launchd's PATH, not the user's, so a
 * bare spawn of `claude` fails with ENOENT on a Mac whenever the boot-time PATH
 * probe did not land — and the failure would be invisible here, quietly
 * downgrading every AI search to a lexical one.
 */
export function askAgent(agentId: string, prompt: string, timeoutMs = TIMEOUT_MS): Promise<string> {
	const agent = getAgent(agentId);
	if (!agent?.headless) return Promise.resolve("");
	const { args, prompt: transport, lastMessageFlag } = agent.headless;
	const dir = lastMessageFlag ? mkdtempSync(join(tmpdir(), "ateam-search-")) : null;
	const outFile = dir ? join(dir, "answer.txt") : null;
	const cmdline = [
		agent.bin,
		...args,
		...(lastMessageFlag && outFile ? [lastMessageFlag, q(outFile)] : []),
		...(transport === "argv" ? [q(prompt)] : []),
	].join(" ");
	return new Promise<string>((resolve) => {
		let done = false;
		const finish = (text: string) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			if (dir) rmSync(dir, { recursive: true, force: true });
			resolve(text);
		};
		const child = spawn(shell, ["-lc", cmdline], { stdio: ["pipe", "pipe", "ignore"] });
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish("");
		}, timeoutMs);
		let stdout = "";
		child.stdout.on("data", (d: Buffer) => {
			// A runaway reply is a broken call, not an answer worth buffering.
			if (stdout.length < 200_000) stdout += d.toString();
		});
		child.on("error", () => finish(""));
		child.on("close", (code) => {
			if (code !== 0) return finish("");
			if (!outFile) return finish(stdout);
			try {
				finish(readFileSync(outFile, "utf8"));
			} catch {
				finish(stdout);
			}
		});
		if (transport === "stdin") {
			child.stdin.end(prompt);
		} else {
			child.stdin.end();
		}
	});
}
