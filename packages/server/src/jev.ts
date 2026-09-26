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
// It runs only when the user has brought an OpenRouter key. Without one, and on
// any failure, the rule's column stands, which is exactly the board as it was.
//
// The questions are decomposed against what the verdict is allowed to DO, as
// Clawnify's doc learned the hard way: the only move it can make is Review →
// Needs you, so each question is one reason the user is needed now, and code
// combines them. One "which column?" choice would come back one-hot and hide
// the reason; four independent answers keep it.

/** Pinned. The threshold below is calibrated against this build; the alias moves. */
export const JEV_MODEL = "typesafe/jev-1.13";

const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

/**
 * How sure an answer must be before it moves a card: Clawnify's "act" tier,
 * confidence 0.90, which for a yes/no answer is a probability of at least 0.95.
 * High on purpose. The model class's published weakness is precision (flags
 * that are not real), and a card moved wrongly is worse than one left where the
 * rule put it: the rule is the behaviour everyone already has.
 * Provisional until tuned against real turns.
 */
export const MOVE_CONFIDENCE = 0.9;

/** The end of a long message is where a closing question sits. */
const MAX_MESSAGE = 4_000;
const MAX_PROMPT = 2_000;

/** A generous hang guard: nothing waits on this, the rule has already filed the card. */
const TIMEOUT_MS = 10_000;

const QUESTIONS = {
	asks_user: {
		type: "noul",
		instructions:
			"Does the agent's final message ask the user a question, or ask them to choose, decide, confirm, approve or provide something, before the agent can continue the task?",
		criteria: {
			true: "The agent is waiting on the user's answer or decision to go on.",
			false:
				"The message reports on work, or the work is finished and any question only offers optional extra work.",
		},
	},
	blocked: {
		type: "noul",
		instructions:
			"Does the agent's final message report that it could not finish because something stopped it, such as an error it could not fix, missing access or credentials, or a failing check it could not resolve?",
	},
	// Clawnify's fourth leg, for the same reason: a turn that stops on "next I
	// will run the tests" did not finish, and nothing else here says so.
	promises_future_work: {
		type: "noul",
		instructions:
			"Does the agent's final message say it is about to do more work, or will do it next, rather than reporting on work already done? Phrases like 'let me', 'I will', 'I am going to', 'next I will' are of this kind.",
	},
	claims_done: {
		type: "noul",
		instructions: "Does the agent's final message report that the requested work is finished?",
	},
} as const;

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
const sureYes = (p: number) => p >= 0.5 && certainty(p) >= MOVE_CONFIDENCE;

/**
 * The policy, in code. Needs you when the agent is sure to be waiting on the
 * user, blocked, or stalled on a promise it did not keep; otherwise Review,
 * which is where the rule already filed it. Confidence belongs to the answer
 * that decided (a failure is as sure as the thing that failed), not the
 * weakest of all four: an unrelated leg near 0.5 must not blur a clear one.
 */
export function decideStep(legs: JevLegs): TurnVerdict {
	const reasons: [number, string][] = [];
	if (sureYes(legs.asks_user)) reasons.push([legs.asks_user, "the agent is waiting on your answer"]);
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
	apiKey: string;
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
	if (!input.apiKey || !finalMessage) return null;

	const ac = new AbortController();
	const onAbort = () => ac.abort();
	input.signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(DECISIONS_URL, {
			method: "POST",
			signal: ac.signal,
			headers: {
				Authorization: `Bearer ${input.apiKey}`,
				"Content-Type": "application/json",
				// OpenRouter's app attribution, so the spend reads as Ateam's.
				"HTTP-Referer": "https://github.com/clawnify/ateam",
				"X-Title": "Ateam",
			},
			body: JSON.stringify({
				model: JEV_MODEL,
				state: {
					users_most_recent_message:
						input.userMessage?.trim().slice(0, MAX_PROMPT) || "(no recent user message)",
					agents_final_message: finalMessage.slice(-MAX_MESSAGE),
				},
				questions: QUESTIONS,
			}),
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { answers?: Record<string, { noul?: unknown }> };
		const legs = {} as JevLegs;
		for (const id of Object.keys(QUESTIONS) as (keyof typeof QUESTIONS)[]) {
			const p = body.answers?.[id]?.noul;
			// Answers are keyed by question id; a missing one is an incomplete
			// verdict, never read as 0.
			if (typeof p !== "number") return null;
			legs[id] = p;
		}
		return decideStep(legs);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
		input.signal?.removeEventListener("abort", onAbort);
	}
}
