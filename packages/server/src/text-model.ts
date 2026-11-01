// The model that writes Ateam's own short text: a task's title and tags at
// launch (task-labels.ts) and the summary of where it stands once its agent goes
// quiet (task-summaries.ts).
//
// Jev, the decision model the board already uses (jev.ts), answers typed
// questions and writes no prose, so text needs a model of its own, and the user
// picks it: `engine.textModel` in settings.json. `auto` takes an OpenRouter
// model when the user has brought a key, the same key Jev runs on: about a
// second a call, a fraction of a cent, no process on the machine. Without a key
// it falls back to Claude Code, headless, on the user's own subscription (about
// 3s and ~300MB a call, measured 2026-11-01). Codex and OpenCode are not offered:
// their small-model ids differ per account, and unpinned `codex exec` runs the
// user's default model at its default effort, often their most expensive.
//
// Every prompt is redacted before it leaves (secrets.ts): a summary quotes the
// user's own messages, and a pasted key must not travel on to OpenRouter.
import { DEFAULT_OPENROUTER_TEXT_MODEL, type EngineSettings } from "@ateam/protocol";
import { openRouterApiKey } from "./credentials-file";
import { askAgent } from "./headless";
import { redactSecrets } from "./secrets";
import { readSettings } from "./settings-file";

const COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
/** Output budget for a model that must reason first: its reasoning and the
 *  reply share `max_tokens`, and its default effort needs far more than a
 *  sentence does. */
const REASONING_ROOM = 2_000;

export type TextModel = { kind: "openrouter"; model: string; apiKey: string } | { kind: "claude" };

/**
 * What writes the text, from the setting and whether a key is set; null when
 * nothing should (the setting is off, or OpenRouter was chosen without a key).
 * An unknown value reads as `auto`: the file is hand-editable.
 */
export function resolveTextModel(
	engine: Pick<EngineSettings, "textModel" | "openRouterTextModel">,
	apiKey: string | undefined,
): TextModel | null {
	const model = engine.openRouterTextModel?.trim() || DEFAULT_OPENROUTER_TEXT_MODEL;
	const openRouter = apiKey ? ({ kind: "openrouter", model, apiKey } as const) : null;
	switch (engine.textModel) {
		case "off":
			return null;
		case "claude":
			return { kind: "claude" };
		case "openrouter":
			return openRouter;
		default:
			return openRouter ?? { kind: "claude" };
	}
}

/** The model as configured right now. Read per call, so a settings edit or a
 *  newly saved key applies to the next title or summary. */
export function currentTextModel(): TextModel | null {
	return resolveTextModel(readSettings().settings.engine, openRouterApiKey());
}

export interface AskTextInput {
	prompt: string;
	/** A ceiling on the reply; the prompts ask for far less. */
	maxTokens: number;
	timeoutMs: number;
}

/**
 * One prompt, one reply. "" on any failure (network, a status that is not 200,
 * a CLI that is missing or not logged in, a timeout): every caller has a
 * fallback that stands when the text never comes.
 */
export async function askTextModel(target: TextModel, input: AskTextInput): Promise<string> {
	const prompt = redactSecrets(input.prompt);
	if (target.kind === "claude") return askAgent("claude", prompt, input.timeoutMs);
	const deadline = AbortSignal.timeout(input.timeoutMs);
	const call = (extra: Record<string, unknown>) =>
		fetch(COMPLETIONS_URL, {
			method: "POST",
			signal: deadline,
			headers: {
				Authorization: `Bearer ${target.apiKey}`,
				"Content-Type": "application/json",
				// OpenRouter's app attribution, as jev.ts sends it.
				"HTTP-Referer": "https://github.com/clawnify/ateam",
				"X-Title": "Ateam",
			},
			body: JSON.stringify({
				model: target.model,
				temperature: 0.2,
				messages: [{ role: "user", content: prompt }],
				...extra,
			}),
		});
	try {
		// Reasoning off. Models that think by default (Haiku 5.5 at medium) spend
		// `max_tokens` on reasoning first: a summary came back as 160 reasoning
		// tokens and no text (2026-11-01). Nothing here needs thinking.
		let res = await call({ max_tokens: input.maxTokens, reasoning: { effort: "none" } });
		// A model that cannot stop reasoning answers 400 ("Reasoning is mandatory
		// for this endpoint", gpt-5-nano): ask again with room for its reasoning.
		if (res.status === 400) {
			res = await call({ max_tokens: Math.max(input.maxTokens * 8, REASONING_ROOM) });
		}
		if (!res.ok) return "";
		const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
		const content = body.choices?.[0]?.message?.content;
		return typeof content === "string" ? content : "";
	} catch {
		return "";
	}
}

/** The configured model's reply, or null when no model is configured. */
export async function askConfiguredTextModel(
	prompt: string,
	opts: Omit<AskTextInput, "prompt">,
): Promise<string | null> {
	const target = currentTextModel();
	return target ? askTextModel(target, { prompt, ...opts }) : null;
}
