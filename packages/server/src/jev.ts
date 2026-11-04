// Board classification by a decision model: which column a card belongs in
// once its agent's turn ends, read from what the agent last said.
//
// The rule files every finished turn in Review, and is wrong whenever the turn
// ended on the user: "Postgres or SQLite?" is not ready for review. Telling the
// two apart is a reading of the final message, so it goes to Jev (TypeSafe's
// decision model, on OpenRouter), the pattern Clawnify's orchestrator stop
// judge runs in production (clawnify: apps/api/src/services/orchestrator/jev.ts,
// docs/internal/system-one-decision-models.md). Jev answers typed questions
// with a probability each, in one parallel pass, and writes no text: nothing to
// parse, no verdict outside the set, ~0.3-0.5s and a few hundredths of a cent.
//
// It runs only when the user has brought a key for a decision model: Jev on
// OpenRouter, or Luna, OpenAI's, on their decisions API (decision-model.ts).
// Without one, and on any failure, the rule's column stands, which is exactly
// the board as it was.
//
// The questions are decomposed against what the verdict is allowed to DO, as
// Clawnify's doc learned the hard way: the only move it can make is Review →
// Needs you, so each question is one reason the user is needed now, and code
// combines them. One "which column?" choice would come back one-hot and hide
// the reason; four independent answers keep it.

import {
	askDecisions,
	type DecisionModel,
	type PerProvider,
	type YesNoQuestion,
} from "./decision-model";

/** Pinned. The thresholds below are calibrated against these builds; aliases move. */
export const BOARD_MODEL: PerProvider<string> = {
	openrouter: "typesafe/jev-1.13",
	openai: "gpt-6-luna",
};

/**
 * How sure an answer must be before it moves a card, per provider: two models
 * put the same certainty at different probabilities, so each gets its own bar.
 *
 * Jev: confidence 0.60, which for a yes/no answer is a probability of at least
 * 0.80. Clawnify's "confirm"
 * tier, the band its stop judge uses for a cheap, bounded action; moving a
 * card is that, and the user moves it back with one drag.
 *
 * Set from a live run (scripts/jev-calibrate.ts, 12 closing messages, 2026-09-26),
 * not from the bands alone. The first setting, 0.90 ("act"), sat exactly where
 * true answers land: a stalled promise scored 0.95 and an unfixable failure
 * 0.94, so both stayed in Review. On turns that belong in Review the highest
 * triggering answer was 0.40 (a finished turn offering optional extra work;
 * "I'll keep an eye on CI" scored 0.48 as a promise, and claims_done 0.94 kept
 * it in Review); true Needs-you answers were 0.94-0.98. 0.80 sits in that gap.
 * At 0.80 the run matched 12/12.
 * Twelve cases are not a corpus: retune from real board moves as they accrue.
 *
 * Luna: the same 0.60, from a live run of the same twelve cases (2026-11-04,
 * `scripts/jev-calibrate.ts --provider openai`), which matched 12/12. Luna
 * answers near the ends: every triggering answer on a turn that belongs in
 * Needs you was 0.97-1.00, and on turns that belong in Review every one was
 * 0.00, the optional offer and "I'll keep an eye on CI" included (Jev put
 * those at 0.40 and 0.49). Any bar in that gap matches; 0.80 keeps Jev's.
 * Calls took 0.2-0.7s warm, 1.4-2.2s for the first few.
 */
export const MOVE_CONFIDENCE: PerProvider<number> = { openrouter: 0.6, openai: 0.6 };

/** The end of a long message is where a closing question sits. */
const MAX_MESSAGE = 4_000;
const MAX_PROMPT = 2_000;

/** A generous hang guard: nothing waits on this, the rule has already filed the card. */
const TIMEOUT_MS = 10_000;

const QUESTIONS = {
	asks_user: {
		instructions:
			"Does the agent's final message ask the user a question, or ask them to choose, decide, confirm, approve or provide something, before the agent can continue the task?",
		criteria: {
			true: "The agent is waiting on the user's answer or decision to go on.",
			false:
				"The message reports on work, or the work is finished and any question only offers optional extra work.",
		},
	},
	blocked: {
		instructions:
			"Does the agent's final message report that it could not finish because something stopped it, such as an error it could not fix, missing access or credentials, or a failing check it could not resolve?",
	},
	// Clawnify's fourth leg, for the same reason: a turn that stops on "next I
	// will run the tests" did not finish, and nothing else here says so.
	promises_future_work: {
		instructions:
			"Does the agent's final message say it is about to do more work, or will do it next, rather than reporting on work already done? Phrases like 'let me', 'I will', 'I am going to', 'next I will' are of this kind.",
	},
	claims_done: {
		instructions: "Does the agent's final message report that the requested work is finished?",
	},
} satisfies Record<string, YesNoQuestion>;

export type JevLegs = Record<keyof typeof QUESTIONS, number>;

export interface TurnVerdict {
	step: "needs_attention" | "review";
	/** One line for the audit trail. */
	reason: string;
	/** Of the answer that decided it (see decideStep). */
	confidence: number;
	legs: JevLegs;
}

/** A yes/no answer carries its certainty in the probability itself. */
const certainty = (p: number) => Math.abs(p - 0.5) * 2;

/**
 * The policy, in code. Needs you when the agent is sure to be waiting on the
 * user, blocked, or stalled on a promise it did not keep; otherwise Review,
 * which is where the rule already filed it. Confidence belongs to the answer
 * that decided (a failure is as sure as the thing that failed), not the
 * weakest of all four: an unrelated leg near 0.5 must not blur a clear one.
 * `moveConfidence` is the answering model's bar (MOVE_CONFIDENCE).
 */
export function decideStep(
	legs: JevLegs,
	moveConfidence: number = MOVE_CONFIDENCE.openrouter,
): TurnVerdict {
	const sureYes = (p: number) => p >= 0.5 && certainty(p) >= moveConfidence;
	const reasons: [number, string][] = [];
	if (sureYes(legs.asks_user))
		reasons.push([legs.asks_user, "the agent is waiting on your answer"]);
	if (sureYes(legs.blocked)) reasons.push([legs.blocked, "the agent reported it is blocked"]);
	// A promise after finished work ("done; I will open the PR next time") is
	// not a stall; only a promise instead of a result is.
	if (sureYes(legs.promises_future_work) && legs.claims_done < 0.5) {
		reasons.push([legs.promises_future_work, "the agent stopped while promising more work"]);
	}
	if (reasons.length === 0) {
		return { step: "review", reason: "the turn ended with a result", confidence: 0, legs };
	}
	const [p, reason] = reasons.reduce((best, r) => (r[0] > best[0] ? r : best));
	return { step: "needs_attention", reason, confidence: certainty(p), legs };
}

export interface ClassifyTurnInput {
	/** Which decision model answers, with its key (decision-model.ts). */
	model: DecisionModel;
	/** What the agent said last in its turn. */
	finalMessage: string;
	/** What the user last asked: their latest reply, else the task's opening prompt. */
	userMessage?: string | null;
	signal?: AbortSignal;
}

/**
 * One call, every question. Null on any failure (no key, network, a status
 * that is not 200, an incomplete answer): this is a second opinion, and losing
 * it must leave the card exactly where the rule filed it.
 */
export async function classifyTurn(input: ClassifyTurnInput): Promise<TurnVerdict | null> {
	const finalMessage = input.finalMessage.trim();
	if (!input.model.apiKey || !finalMessage) return null;
	const legs = await askDecisions({
		target: input.model,
		model: BOARD_MODEL[input.model.provider],
		state: {
			users_most_recent_message:
				input.userMessage?.trim().slice(0, MAX_PROMPT) || "(no recent user message)",
			agents_final_message: finalMessage.slice(-MAX_MESSAGE),
		},
		questions: QUESTIONS,
		timeoutMs: TIMEOUT_MS,
		signal: input.signal,
	});
	return legs ? decideStep(legs, MOVE_CONFIDENCE[input.model.provider]) : null;
}
