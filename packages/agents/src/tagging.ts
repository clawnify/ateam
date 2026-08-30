/**
 * Model-assisted task tagging: the app's first headless LLM call.
 *
 * Keyword tagging over Ateam's task text was measured on a real 400-task board
 * and reached only 24% coverage, because a task's name is six slugified words
 * of conversational English ("I am not a fan of") while the keyword vocabulary
 * is dev jargon. Even fed whole prompts it managed ~50%, with false positives.
 * A model reads intent instead of matching words, which is the difference
 * between a decorative feature and a usable axis.
 *
 * Three deliberate constraints:
 *
 *  • CLOSED VOCABULARY. The model picks from a fixed list plus whatever tags
 *    the project already uses. Free-form tagging drifts into `frontend` /
 *    `front-end` / `ui` across three tasks and the axis stops grouping anything.
 *  • NEVER BLOCKING. This runs after the agent is already launched, so a slow
 *    or missing `claude` delays nothing the user is waiting on. Tags simply
 *    appear a few seconds later.
 *  • ALWAYS RECOVERABLE. Every failure path (no CLI, timeout, unparseable
 *    output, junk tags) returns null, and the caller keeps the keyword
 *    fallback. Tagging must never be able to break task creation.
 *
 * Invocation contract verified against claude 2.1.251: the prompt goes on
 * STDIN, `--strict-mcp-config` skips the user's MCP servers, and cwd is a temp
 * dir so the target repo's CLAUDE.md and hooks are not loaded. Measured ~4.2s.
 * Counter-intuitively `--model haiku` is SLOWER here (startup-bound, not
 * inference-bound), so sonnet is the fast choice.
 */

import { execFile } from "node:child_process";
import { tmpdir } from "node:os";

/** The house vocabulary: the same categories the card icons already use. */
export const TAG_VOCABULARY = [
	"bug",
	"docs",
	"auth",
	"ui",
	"test",
	"db",
	"api",
	"perf",
	"refactor",
	"release",
	"feat",
	"content",
] as const;

/** Hard cap, matching what a card can show without becoming a wall of chips. */
export const MAX_TAGS = 3;
/** Generous next to a measured ~4.2s; this is a hang guard, not a deadline. */
const TIMEOUT_MS = 30_000;
/** Truncate long prompts: intent is in the opening, and tokens cost latency. */
const MAX_PROMPT_CHARS = 2000;

export interface TagOptions {
	/** Tags already in use on this project, so the model reuses before inventing. */
	knownTags?: string[];
	/** Injectable for tests; defaults to the real `claude` CLI. */
	run?: (input: string) => Promise<string>;
}

function buildPrompt(taskPrompt: string, knownTags: string[]): string {
	const vocab = [...new Set([...TAG_VOCABULARY, ...knownTags])].join(" ");
	return [
		"You label software tasks with topic tags. Reply with ONLY a JSON array of",
		`strings, no prose, no code fence. Choose 1 to ${MAX_TAGS} tags that describe what the`,
		"task is ABOUT. Prefer tags from this list; only invent one if nothing fits,",
		"and then use a single lowercase word:",
		vocab,
		"",
		"If the text is too vague to label, reply with an empty array [].",
		"",
		"Task:",
		taskPrompt.slice(0, MAX_PROMPT_CHARS),
	].join("\n");
}

/** Run the real CLI: prompt on stdin, cwd a temp dir so no repo config loads. */
function runClaude(input: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			"claude",
			["-p", "--strict-mcp-config", "--model", "sonnet"],
			{ cwd: tmpdir(), timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
			(err, stdout) => (err ? reject(err) : resolve(stdout)),
		);
		child.stdin?.end(input);
	});
}

/**
 * Keep only clean, in-vocabulary-shaped tags. A model asked for lowercase words
 * will occasionally return "UI Polish" or a sentence; this is the boundary that
 * stops that reaching the database.
 */
export function sanitizeTags(raw: unknown, knownTags: string[] = []): string[] {
	if (!Array.isArray(raw)) return [];
	const allowed = new Set<string>([...TAG_VOCABULARY, ...knownTags]);
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const tag = item.trim().toLowerCase();
		// A tag is one short word: anything else is the model narrating.
		if (!/^[a-z][a-z0-9-]{1,15}$/.test(tag)) continue;
		if (!allowed.has(tag) && out.length > 0) continue; // at most one newcomer, and only leading
		if (out.includes(tag)) continue;
		out.push(tag);
		if (out.length === MAX_TAGS) break;
	}
	return out;
}

/** Pull the JSON array out of a reply that may carry a stray fence or preamble. */
export function parseTagReply(stdout: string): unknown {
	const text = stdout
		.trim()
		.replace(/^```(?:json)?/i, "")
		.replace(/```$/, "");
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start === -1 || end === -1 || end < start) return null;
	try {
		return JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
}

/**
 * Tags for one task's originating prompt, or null when the model could not be
 * reached or said nothing usable. Null means "keep the keyword fallback", which
 * is why every failure collapses to it rather than throwing.
 */
export async function generateTaskTags(
	taskPrompt: string,
	opts: TagOptions = {},
): Promise<string[] | null> {
	const prompt = taskPrompt.trim();
	if (!prompt) return null;
	const knownTags = opts.knownTags ?? [];
	try {
		const stdout = await (opts.run ?? runClaude)(buildPrompt(prompt, knownTags));
		const tags = sanitizeTags(parseTagReply(stdout), knownTags);
		return tags.length > 0 ? tags : null;
	} catch {
		// No CLI, not logged in, timeout, crash: all mean "no tags today".
		return null;
	}
}
