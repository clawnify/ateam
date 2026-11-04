// Which grammar suggestions are worth showing, by the same decision model the
// board uses (jev.ts, decision-model.ts: Jev on OpenRouter or Luna on OpenAI). Harper, the local grammar checker, flags what it can't
// read: a typo like "wich", but also slang ("shouty", "lol") and names it has
// never seen. Telling those apart is a reading of the prompt, so Jev answers
// one yes/no question per flagged word, all in one call.
//
// Jev only ever removes issues Harper found; it never adds one. With no key,
// the setting off, a draft that may hold a secret, or any failure, every
// issue Harper found stands, which is the grammar check as it works offline.

import {
	askDecisions,
	type DecisionModel,
	type PerProvider,
	type YesNoQuestion,
} from "./decision-model";
import { looksSecret } from "./secrets";

/**
 * Pinned, separately from the board's: the thresholds below are calibrated
 * against these builds (scripts/grammar-jev-calibrate.ts in apps/desktop).
 */
export const GRAMMAR_MODEL: PerProvider<string> = {
	openrouter: "typesafe/jev-1.14",
	openai: "gpt-6-luna",
};

/**
 * An issue shows when the model puts it at this probability or above.
 *
 * Jev: set from a live run (2026-10-25, 16 drafts through Harper and the toolbar filter, 17
 * judged words): real mistakes ("wich", "outide", "retrys", "way to short")
 * scored 0.91-0.97, slang and names ("lol", "shouty", "supabase", "lmk")
 * 0.03-0.21, so 0.5 sits mid-gap and matched 17/17. Note the board's 0.80
 * bar would be wrong here: an earlier "its → it's" scored 0.71-0.78.
 *
 * Luna: the same 0.5, from a live run of the same drafts (2026-11-04,
 * grammar-jev-calibrate.ts --provider openai), 17/17: real mistakes scored
 * 0.99-1.00, slang and names ("lol", "shouty", "pls", "mins", "supabase")
 * 0.00-0.11. Calls took 0.26-0.70s, inside TIMEOUT_MS.
 */
export const KEEP_PROBABILITY: PerProvider<number> = { openrouter: 0.5, openai: 0.5 };

/**
 * Someone is waiting on this: the suggestions appear only once it answers.
 * Measured at 0.2-0.4s warm, ~0.5s cold (2026-10-25); past this, Harper's list shows.
 */
const TIMEOUT_MS = 1_000;

const MAX_DRAFT = 2_000;
/** Characters of the draft quoted on each side of a flagged word. */
const CONTEXT = 40;

/** One of Harper's issues, as much of it as the question needs. */
export interface GrammarJudgeIssue {
	start: number;
	end: number;
	problem: string;
	message: string;
	suggestions: string[];
}

export interface GrammarVerdict {
	/** Jev's probability that the issue is a real mistake. */
	p: number;
	keep: boolean;
}

function question(draft: string, issue: GrammarJudgeIssue): YesNoQuestion {
	const before = draft.slice(Math.max(0, issue.start - CONTEXT), issue.start);
	const after = draft.slice(issue.end, issue.end + CONTEXT);
	const fixes = issue.suggestions.length
		? ` It suggests: ${issue.suggestions.map((s) => `"${s}"`).join(", ")}.`
		: "";
	return {
		instructions: `The user is typing a casual prompt to an AI coding agent. A grammar checker flagged "${issue.problem}" in "…${before}[${issue.problem}]${after}…": ${issue.message}${fixes} Is "${issue.problem}" a real mistake the user would want corrected, rather than deliberate slang, a name, a technical term, or a casual word they meant?`,
		criteria: {
			true: "A typo, misspelling or grammar error the user would fix if they noticed it.",
			false: "Slang, a name, jargon or casual wording the user wrote on purpose.",
		},
	};
}

/**
 * Verdicts already given, so a word isn't asked about again at every pause in
 * typing. Keyed by the word, why it was flagged, and the text before it:
 * typing on after a word, the usual case, keeps its key.
 */
const verdicts = new Map<string, GrammarVerdict>();
const MAX_VERDICTS = 500;
const verdictKey = (model: DecisionModel, draft: string, issue: GrammarJudgeIssue) =>
	`${model.provider}\u0000${draft.slice(Math.max(0, issue.start - CONTEXT), issue.end)}\u0000${issue.message}`;

/**
 * A verdict per issue, in the order given, asking Jev (one call) only about
 * the issues it hasn't judged yet. Null when there is nothing to ask, the
 * draft may hold a secret, or Jev did not answer in time: the caller then
 * shows every issue.
 */
export async function judgeGrammar(input: {
	/** Which decision model answers, with its key (decision-model.ts). */
	model: DecisionModel;
	draft: string;
	issues: GrammarJudgeIssue[];
	signal?: AbortSignal;
}): Promise<GrammarVerdict[] | null> {
	if (!input.model.apiKey || input.issues.length === 0 || looksSecret(input.draft)) return null;
	const keep = KEEP_PROBABILITY[input.model.provider];
	const keys = input.issues.map((issue) => verdictKey(input.model, input.draft, issue));
	const unasked = input.issues.filter((_, i) => !verdicts.has(keys[i] ?? ""));
	if (unasked.length > 0) {
		const questions = Object.fromEntries(
			unasked.map((issue, i) => [`issue_${i}`, question(input.draft, issue)]),
		);
		const answers = await askDecisions({
			target: input.model,
			model: GRAMMAR_MODEL[input.model.provider],
			state: { draft_prompt: input.draft.slice(0, MAX_DRAFT) },
			questions,
			timeoutMs: TIMEOUT_MS,
			signal: input.signal,
		});
		if (!answers) return null;
		// shortcut: dropped whole when full; an LRU only if hit rates show it matters.
		if (verdicts.size + unasked.length > MAX_VERDICTS) verdicts.clear();
		unasked.forEach((issue, i) => {
			const p = answers[`issue_${i}`] ?? 0;
			verdicts.set(verdictKey(input.model, input.draft, issue), { p, keep: p >= keep });
		});
	}
	const out: GrammarVerdict[] = [];
	for (const key of keys) {
		const v = verdicts.get(key);
		// Only if the cache was cleared under us mid-call; show everything.
		if (!v) return null;
		out.push(v);
	}
	return out;
}
