// The decision model: yes/no questions in, a probability for each out, and no
// text. The board's turn classifier (jev.ts) and the grammar filter
// (grammar-jev.ts) ask it; each keeps its own questions, pinned models and
// thresholds, and this module only picks the provider and carries the call.
//
// Two providers serve one, each with the user's own key (credentials-file.ts):
//
//  • Jev, TypeSafe's decision model, on OpenRouter's decisions endpoint.
//    Questions are a map keyed by id, each `{type: "noul"}`, and so are the
//    answers (`answers[id].noul`).
//  • Luna, on OpenAI's /v1/decisions (public beta since 2026-10-06; gpt-6-luna
//    is its only model). Questions are a list of `{type: "predicate", name}`,
//    and answers come back as a list carrying the same name and a
//    `probability`. It has no `criteria` field, so a question's criteria go
//    into its instructions. OpenRouter does not serve Luna (probed
//    2026-11-04: "Model openai/gpt-6-luna does not exist"), so Luna needs the
//    OpenAI key.
//
// `engine.decisionModel` chooses; `auto` takes Jev when the OpenRouter key is
// set (the model the thresholds were first calibrated on), else Luna.
import type { EngineSettings } from "@ateam/protocol";
import { openAiApiKey, openRouterApiKey } from "./credentials-file";
import { readSettings } from "./settings-file";

export type DecisionProvider = "openrouter" | "openai";

export interface DecisionModel {
	provider: DecisionProvider;
	apiKey: string;
}

/** One value per provider: each use pins its own model and calibrates its own bar. */
export type PerProvider<T> = Record<DecisionProvider, T>;

/**
 * Which provider answers, from the setting and the keys that are set; null
 * when none should (the setting is off, or the chosen provider has no key). An
 * unknown value reads as `auto`: the file is hand-editable.
 */
export function resolveDecisionModel(
	engine: Pick<EngineSettings, "decisionModel">,
	keys: { openRouter?: string; openAi?: string },
): DecisionModel | null {
	const openRouter: DecisionModel | null = keys.openRouter
		? { provider: "openrouter", apiKey: keys.openRouter }
		: null;
	const openAi: DecisionModel | null = keys.openAi
		? { provider: "openai", apiKey: keys.openAi }
		: null;
	switch (engine.decisionModel) {
		case "off":
			return null;
		case "openrouter":
			return openRouter;
		case "openai":
			return openAi;
		default:
			return openRouter ?? openAi;
	}
}

/** As configured right now. Read per call, so a saved key or a settings edit
 *  applies to the next question. */
export function currentDecisionModel(): DecisionModel | null {
	return resolveDecisionModel(readSettings().settings.engine, {
		openRouter: openRouterApiKey(),
		openAi: openAiApiKey(),
	});
}

export interface YesNoQuestion {
	instructions: string;
	/** What a yes and a no each mean, when the question alone leaves room. */
	criteria?: { true: string; false: string };
}

export interface AskDecisionsInput<Q extends Record<string, YesNoQuestion>> {
	target: DecisionModel;
	/** The model id at that provider. */
	model: string;
	/** What the questions are about, by name. */
	state: Record<string, string>;
	/** Keyed by the id each answer comes back under. */
	questions: Q;
	timeoutMs: number;
	signal?: AbortSignal;
}

const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const OPENAI_DECISIONS_URL = "https://api.openai.com/v1/decisions";

/**
 * One request: each question's probability of a yes, keyed by question id.
 * Null on any failure (network, timeout, a status that is not 200, an answer
 * missing or refused), so every caller keeps its own path for no answer.
 */
export async function askDecisions<Q extends Record<string, YesNoQuestion>>(
	input: AskDecisionsInput<Q>,
): Promise<Record<keyof Q, number> | null> {
	const ac = new AbortController();
	const onAbort = () => ac.abort();
	input.signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => ac.abort(), input.timeoutMs);
	const ids = Object.keys(input.questions) as (keyof Q & string)[];
	try {
		const openAi = input.target.provider === "openai";
		const res = await fetch(openAi ? OPENAI_DECISIONS_URL : OPENROUTER_DECISIONS_URL, {
			method: "POST",
			signal: ac.signal,
			headers: {
				Authorization: `Bearer ${input.target.apiKey}`,
				"Content-Type": "application/json",
				// OpenRouter's app attribution, so the spend reads as Ateam's.
				...(openAi
					? {}
					: { "HTTP-Referer": "https://github.com/clawnify/ateam", "X-Title": "Ateam" }),
			},
			body: JSON.stringify(openAi ? openAiBody(input) : openRouterBody(input)),
		});
		if (!res.ok) return null;
		const body: unknown = await res.json();
		const read = openAi ? openAiAnswer(body) : openRouterAnswer(body);
		const answers = {} as Record<keyof Q, number>;
		for (const id of ids) {
			const p = read(id);
			// A missing (or refused) answer is an incomplete verdict, never read as 0.
			if (typeof p !== "number") return null;
			answers[id] = p;
		}
		return answers;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
		input.signal?.removeEventListener("abort", onAbort);
	}
}

function openRouterBody<Q extends Record<string, YesNoQuestion>>(input: AskDecisionsInput<Q>) {
	const questions = Object.fromEntries(
		Object.entries(input.questions).map(([id, q]) => [id, { type: "noul", ...q }]),
	);
	return { model: input.model, state: input.state, questions };
}

function openRouterAnswer(body: unknown) {
	const answers = (body as { answers?: Record<string, { noul?: unknown }> } | null)?.answers;
	return (id: string) => answers?.[id]?.noul;
}

function openAiBody<Q extends Record<string, YesNoQuestion>>(input: AskDecisionsInput<Q>) {
	return {
		model: input.model,
		// The state as named sections, the way Jev receives it as named fields.
		input: Object.entries(input.state)
			.map(([name, text]) => `<${name}>\n${text}\n</${name}>`)
			.join("\n\n"),
		questions: Object.entries(input.questions).map(([name, q]) => ({
			type: "predicate",
			name,
			instructions: q.criteria
				? `${q.instructions}\nTrue: ${q.criteria.true}\nFalse: ${q.criteria.false}`
				: q.instructions,
		})),
	};
}

function openAiAnswer(body: unknown) {
	const answers = (
		body as { answers?: { type?: unknown; name?: unknown; probability?: unknown }[] } | null
	)?.answers;
	return (id: string) => {
		const a = Array.isArray(answers) ? answers.find((x) => x?.name === id) : undefined;
		// A refusal carries the name and no probability.
		return a?.type === "predicate" ? a.probability : undefined;
	};
}
