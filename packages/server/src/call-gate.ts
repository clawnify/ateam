// What a voice call heard, and whether it was said to the Lead. On a call
// (apps/desktop renderer lead-call.ts) the mic hears the whole room: the user
// talking to the Lead, but also the user talking to someone else, other people,
// a TV. Only words said to the Lead may reach it, since the Lead acts on what it
// is told. The decision model (decision-model.ts: Jev on OpenRouter or Luna on
// OpenAI) is fast and cheap, so it judges every utterance the call hears: a few
// yes/no questions per piece of speech, all in one call.
//
// It reads words only; the voice (GPT-Live) hears the sound. With no model, or
// no answer in time, the caller falls back on the voice's own hand-off.

import {
	askDecisions,
	type DecisionModel,
	type PerProvider,
	type YesNoQuestion,
} from "./decision-model";

/** Pinned: SEND_PROBABILITY is calibrated against these (apps/desktop
 *  scripts/call-gate-calibrate.ts). */
export const CALL_GATE_MODEL: PerProvider<string> = {
	openrouter: "typesafe/jev-1.14",
	openai: "gpt-6-luna",
};

/**
 * A piece of speech goes to the Lead when it is put at this probability or
 * above of being said to the Lead.
 *
 * Jev: 0.7, from live runs (2026-11-05, call-gate-calibrate.ts, 18 pieces:
 * requests, thinking aloud, side talk to a partner, a child, another call, TV
 * news, filler). Over three runs, pieces for the Lead scored 0.82-0.96 and the
 * rest 0.03-0.60 (the highest: "Um." and "Hold on, I'll be right back"), so 0.7
 * sits in the gap; 0.5 sent the "Um.". 18/18 at 0.7.
 * Luna: 0.5 (--provider openai): pieces for the Lead 0.98-1.00, the rest
 * 0.00-0.31; it answers near the ends, as it did for the board and grammar.
 * 17/18: it refused one TV news line (no answer), which the caller holds.
 */
export const SEND_PROBABILITY: PerProvider<number> = { openrouter: 0.7, openai: 0.5 };

/** The user is waiting on the Lead, which takes seconds; this only has to stay
 *  well under that. Luna's first call of a session took 1.7-2.0 s (cold), so
 *  the call warms it up when it opens (lead-call.ts). */
const TIMEOUT_MS = 3_000;
/** At most this many pieces per call: the newest. */
export const MAX_PIECES = 4;
const MAX_PIECE = 600;
const MAX_CONTEXT = 3_000;

export type SpeechKind = "lead" | "someone" | "background" | "unclear";

export interface SpeechVerdict {
	/** The probability it was said to the Lead. */
	p: number;
	send: boolean;
	/** What it most likely was, for the words the user sees when it isn't sent. */
	kind: SpeechKind;
}

const CALL = `The user is on a voice call with "the Lead", an AI that runs their software work: coding tasks, the board of tasks, the product's direction. The microphone in their room hears everything, not only the user talking to the Lead.`;

function questions(n: number): Record<string, YesNoQuestion> {
	const out: Record<string, YesNoQuestion> = {};
	for (let i = 0; i < n; i++) {
		const piece = `piece_${i + 1}`;
		out[`${piece}_lead`] = {
			instructions: `${CALL} Was ${piece} said by the user to the Lead: a question, idea, instruction, decision, an answer to the Lead, thinking aloud about their work or product, or a question about this call itself (what was said, where they were)?`,
			criteria: {
				true: "Words meant for the Lead: about the work, half-formed thoughts about the product, or about the conversation with the Lead.",
				false: "Words meant for someone else, from a TV or video, or filler with no meaning alone.",
			},
		};
		out[`${piece}_someone`] = {
			instructions: `${CALL} Was ${piece} said to another person, in the room or on another call (a partner, a child, a colleague), rather than to the Lead?`,
		};
		out[`${piece}_background`] = {
			instructions: `${CALL} Did ${piece} come from a TV, a video, music or a bystander, rather than from the user speaking?`,
		};
	}
	return out;
}

/** The verdict for one piece, from its three probabilities. */
export function verdictOf(
	p: { lead: number; someone: number; background: number },
	bar: number,
): SpeechVerdict {
	const send = p.lead >= bar;
	const kind: SpeechKind = send
		? "lead"
		: p.background >= 0.5 && p.background >= p.someone
			? "background"
			: p.someone >= 0.5
				? "someone"
				: "unclear";
	return { p: p.lead, send, kind };
}

/**
 * A verdict per piece of speech, in the order given (only the newest
 * MAX_PIECES are judged; older ones come back unsent). Null when there is
 * nothing to ask or the model did not answer in time: the caller decides.
 */
export async function judgeSpeech(input: {
	model: DecisionModel;
	/** What the call heard, in order, split at pauses. */
	pieces: string[];
	/** The call so far: the last turns, oldest first, one per line. */
	context: string;
	signal?: AbortSignal;
}): Promise<SpeechVerdict[] | null> {
	if (!input.model.apiKey || input.pieces.length === 0) return null;
	const skipped = Math.max(0, input.pieces.length - MAX_PIECES);
	const judged = input.pieces.slice(skipped).map((p) => p.slice(0, MAX_PIECE));
	const state: Record<string, string> = {
		call_so_far: input.context.slice(-MAX_CONTEXT) || "(nothing yet)",
	};
	judged.forEach((p, i) => {
		state[`piece_${i + 1}`] = p;
	});
	const answers = await askDecisions({
		target: input.model,
		model: CALL_GATE_MODEL[input.model.provider],
		state,
		questions: questions(judged.length),
		timeoutMs: TIMEOUT_MS,
		signal: input.signal,
	});
	if (!answers) return null;
	const bar = SEND_PROBABILITY[input.model.provider];
	const unsent: SpeechVerdict = { p: 0, send: false, kind: "unclear" };
	return [
		...Array.from({ length: skipped }, () => unsent),
		...judged.map((_, i) =>
			verdictOf(
				{
					lead: answers[`piece_${i + 1}_lead`] ?? 0,
					someone: answers[`piece_${i + 1}_someone`] ?? 0,
					background: answers[`piece_${i + 1}_background`] ?? 0,
				},
				bar,
			),
		),
	];
}
