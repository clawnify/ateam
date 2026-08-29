/**
 * Shared digest helpers — the part of "what is worth searching" that every
 * harness agrees on. Pure functions, unit-tested in
 * packages/server/test/session-search.test.ts.
 */

/** Per-prompt cap. Long enough to carry the intent, short enough that a whole
 *  history stays a few hundred KB rather than the ~1GB the transcripts are. */
const MAX_PROMPT_CHARS = 600;
/** Per-session cap. Later prompts drift into follow-ups ("yes", "continue"). */
const MAX_PROMPTS = 40;

/**
 * Wrapper blocks the harnesses inject into the user role: slash-command
 * plumbing, hook output, environment headers. They are not things the user
 * typed, and left in they dominate the corpus (a single expanded skill body can
 * outweigh every real prompt in a session).
 */
const INJECTED = [
	/<command-(message|name|args)>[\s\S]*?<\/command-(message|name|args)>/g,
	/<local-command-(stdout|stderr)>[\s\S]*?<\/local-command-(stdout|stderr)>/g,
	/<system-reminder>[\s\S]*?<\/system-reminder>/g,
	/<environment_context>[\s\S]*?<\/environment_context>/g,
	/<user_instructions>[\s\S]*?<\/user_instructions>/g,
];

/**
 * Harness bookkeeping that appears in the user role but is not speech: the line
 * the CLI writes when a turn is cancelled. It carries no information about what
 * the session was about, and left in it becomes a session's "excerpt".
 */
const NOISE = /^\[Request interrupted[^\]]*\]$/;

/** Strip injected wrappers and collapse whitespace. "" when nothing is left. */
export function cleanPrompt(text: string): string {
	let s = text;
	for (const re of INJECTED) s = s.replace(re, " ");
	// A caveat banner is prepended to the first message of a resumed session.
	s = s.replace(/^Caveat: The messages below[\s\S]*?<\/command-name>/, " ");
	s = s.replace(/\s+/g, " ").trim();
	// What survives as a bare tag was structure, not speech.
	if (s.startsWith("<") && s.endsWith(">")) return "";
	if (NOISE.test(s)) return "";
	return s.slice(0, MAX_PROMPT_CHARS);
}

/** Flatten a message `content` (string, or Anthropic-style block array) to text. */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b) => {
			if (typeof b === "string") return b;
			if (b && typeof b === "object") {
				const t = (b as { text?: unknown }).text;
				if (typeof t === "string") return t;
			}
			return "";
		})
		.join(" ");
}

/** Append a user message to a session's prompt list, if it says anything. */
export function pushPrompt(prompts: string[], content: unknown): void {
	if (prompts.length >= MAX_PROMPTS) return;
	const text = cleanPrompt(contentText(content));
	if (text) prompts.push(text);
}
