// The model that writes Ateam's own short text: a task's title and tags at
// launch (task-labels.ts) and the summary of where it stands once its agent goes
// quiet (task-summaries.ts).
//
// Jev, the decision model the board already uses (jev.ts), answers typed
// questions and writes no prose, so text needs a model of its own, and the user
// picks it: `engine.textModel` in settings.json. `auto` takes an OpenRouter
// model when the user has brought that key, else an OpenAI one when they have
// brought that key (the same keys the decision model runs on): about a second a
// call, a fraction of a cent, no process on the machine. Without a key it falls
// back to Claude Code, headless, on the user's own subscription (about 3s and
// ~300MB a call, measured 2026-11-01). Codex and OpenCode are not offered:
// their small-model ids differ per account, and unpinned `codex exec` runs the
// user's default model at its default effort, often their most expensive.
//
// Every prompt is redacted before it leaves (secrets.ts): a summary quotes the
// user's own messages, and a pasted key must not travel on to a provider.
import {
	DEFAULT_OPENAI_TEXT_MODEL,
	DEFAULT_OPENROUTER_TEXT_MODEL,
	type EngineSettings,
} from "@ateam/protocol";
import { openAiApiKey, openRouterApiKey } from "./credentials-file";
import { askAgent } from "./headless";
import { redactSecrets } from "./secrets";
import { readSettings } from "./settings-file";

const OPENROUTER_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENAI_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
/** Output budget for a model that must reason first: its reasoning and the
 *  reply share `max_tokens`, and its default effort needs far more than a
 *  sentence does. */
const REASONING_ROOM = 2_000;

export type TextModel =
	| { kind: "openrouter" | "openai"; model: string; apiKey: string }
	| { kind: "claude" };

/**
 * What writes the text, from the setting and which keys are set; null when
 * nothing should (the setting is off, or a provider was chosen without its
 * key). An unknown value reads as `auto`: the file is hand-editable.
 */
export function resolveTextModel(
	engine: Pick<EngineSettings, "textModel" | "openRouterTextModel" | "openAiTextModel">,
	keys: { openRouter?: string; openAi?: string },
): TextModel | null {
	const openRouter = keys.openRouter
		? ({
				kind: "openrouter",
				model: engine.openRouterTextModel?.trim() || DEFAULT_OPENROUTER_TEXT_MODEL,
				apiKey: keys.openRouter,
			} as const)
		: null;
	const openAi = keys.openAi
		? ({
				kind: "openai",
				model: engine.openAiTextModel?.trim() || DEFAULT_OPENAI_TEXT_MODEL,
				apiKey: keys.openAi,
			} as const)
		: null;
	switch (engine.textModel) {
		case "off":
			return null;
		case "claude":
			return { kind: "claude" };
		case "openrouter":
			return openRouter;
		case "openai":
			return openAi;
		default:
			return openRouter ?? openAi ?? { kind: "claude" };
	}
}

/** The model as configured right now. Read per call, so a settings edit or a
 *  newly saved key applies to the next title or summary. */
export function currentTextModel(): TextModel | null {
	return resolveTextModel(readSettings().settings.engine, {
		openRouter: openRouterApiKey(),
		openAi: openAiApiKey(),
	});
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
	const openAi = target.kind === "openai";
	const call = (extra: Record<string, unknown>) =>
		fetch(openAi ? OPENAI_COMPLETIONS_URL : OPENROUTER_COMPLETIONS_URL, {
			method: "POST",
			signal: deadline,
			headers: {
				Authorization: `Bearer ${target.apiKey}`,
				"Content-Type": "application/json",
				// OpenRouter's app attribution, as decision-model.ts sends it.
				...(openAi
					? {}
					: { "HTTP-Referer": "https://github.com/clawnify/ateam", "X-Title": "Ateam" }),
			},
			body: JSON.stringify({
				model: target.model,
				messages: [{ role: "user", content: prompt }],
				...extra,
			}),
		});
	// Reasoning off. Models that think by default (Haiku 5.5 at medium) spend the
	// output budget on reasoning first: a summary came back as 160 reasoning
	// tokens and no text (2026-11-01). Nothing here needs thinking. OpenRouter
	// takes `reasoning.effort` and `max_tokens`; OpenAI's Chat Completions takes
	// `reasoning_effort` and `max_completion_tokens`, and drops `temperature`
	// whenever a model does reason, so it isn't sent there.
	const budget = (n: number) => (openAi ? { max_completion_tokens: n } : { max_tokens: n });
	const reasoningOff = openAi
		? { reasoning_effort: "none" }
		: { reasoning: { effort: "none" }, temperature: 0.2 };
	try {
		let res = await call({ ...budget(input.maxTokens), ...reasoningOff });
		// A model that cannot stop reasoning answers 400 ("Reasoning is mandatory
		// for this endpoint", gpt-5-nano): ask again with room for its reasoning.
		if (res.status === 400) {
			res = await call(budget(Math.max(input.maxTokens * 8, REASONING_ROOM)));
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
