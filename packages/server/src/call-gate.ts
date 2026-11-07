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

import { CALL_MAX_PIECES } from "@ateam/protocol";
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
 * sits in the gap; 0.5 sent the "Um.". 18/18 at 0.7. With three bare "okok"
 * cases added (a yes to the Lead's question, or to someone the user just asked
 * something, told apart by the held aside and the ages in the context): 21/21,
 * the "okok" for the Lead at 0.80-0.81, the one for someone else at 0.39.
 * Luna: 0.5 (--provider openai): pieces for the Lead 0.90-1.00, the rest
 * 0.00-0.31; it answers near the ends, as it did for the board and grammar.
 * 20/21: it refused one TV news line (no answer), which the caller holds.
 */
export const SEND_PROBABILITY: PerProvider<number> = { openrouter: 0.7, openai: 0.5 };

/**
 * The bar when the voice handed the words off as said to it. Neither alone is
 * enough: the voice alone forwarded side talk (why this gate exists), and words
 * alone can't tell who the user turned to: after "Mom, hold on a second.",
 * Jev put "Delete the old test box" at 0.36-0.64, as said to Mom, while the
 * voice, hearing the room, handed it off (2026-11-05). Side talk scored
 * 0.03-0.45 on Jev and 0.00-0.31 on Luna, under this bar either way. Known:
 * with no sentence end between them in the transcript, the two are one piece
 * and held together, with Send.
 */
export const HANDED_OFF_PROBABILITY = 0.5;

/** The user is waiting on the Lead, which takes seconds; this only has to stay
 *  well under that. Luna's first call of a session took 1.7-2.0 s (cold), so
 *  the call warms it up when it opens (lead-call.ts). */
const TIMEOUT_MS = 3_000;
/** At most this many pieces per call (the call joins its oldest past it). */
export const MAX_PIECES = CALL_MAX_PIECES;
const MAX_PIECE = 600;
const MAX_CONTEXT = 3_000;

export type SpeechKind = "lead" | "someone" | "background" | "unclear";

export interface SpeechVerdict {
	/** The probability it was said to the Lead. */
	p: number;
	send: boolean;
	/** What it most likely was, for the words the user sees when it isn't sent. */
	kind: SpeechKind;
	/** With an open topic: the probability it is about that topic. */
	about?: number;
	/** It is about the open topic, at that kind's bar (ABOUT_PROBABILITY). */
	onTopic?: boolean;
	/** With a confirmation open: the user's yes or no to it, when it is one. */
	answer?: "approve" | "refuse" | null;
	/** With a decision's options open: the one the user chose, by index, when
	 *  they clearly chose one ("go ahead" is its recommended option). */
	choice?: number | null;
}

/**
 * What the call just raised, for judging what comes next against it. A
 * confirmation (a card: send this message? run this?) may be answered by a
 * spoken yes or no; a decision (a task's question with options) is only ever
 * talked about here, never answered by what was said near it (the user,
 * 2026-11-05: "these require some thought as they are proper decisions"),
 * unless a button is clearly picked; a task's reply, said in one line, is only
 * talked about.
 */
export interface SpeechTopic {
	kind: "confirm" | "decision" | "reply";
	/** The card or the question, in plain words. */
	text: string;
	/** A decision's buttons, in order: the user's words may pick one. */
	options?: { label: string; recommended?: boolean; description?: string }[];
}

/** At most this many options are asked about (a question's buttons). */
export const MAX_OPTIONS = 6;

/**
 * An option counts as chosen at this probability, and this far ahead of the
 * next best: words that could mean two buttons choose neither, and go to the
 * Lead to talk it through. Live runs 2026-11-05 (call-gate-calibrate.ts, 9 cases
 * on a three-button decision: "go ahead", "keep it as it is", "the second
 * one", "let's decide later", and four that choose nothing): Jev 9/9, Luna 8/9
 * (it once left "the second one" unchosen, which sends it to the Lead instead).
 * Neither ever chose a wrong button. "Not sure yet" chose "Decide later" on
 * Luna until the question said that being unsure chooses nothing.
 */
export const CHOOSE_PROBABILITY: PerProvider<number> = { openrouter: 0.7, openai: 0.6 };
export const CHOOSE_MARGIN = 0.25;

/** The option a piece chose, from its probabilities, or null. */
export function choiceOf(about: number, chose: number[], bar: number): number | null {
	if (about < 0.5 || !chose.length) return null;
	const order = chose.map((p, i) => ({ p, i })).sort((a, b) => b.p - a.p);
	const [best, next] = order;
	if (!best || best.p < bar) return null;
	if (next && best.p - next.p < CHOOSE_MARGIN) return null;
	return best.i;
}

/**
 * A yes or no to a confirmation counts at this probability (and above the
 * other). Live run 2026-11-05 (call-gate-calibrate.ts, 14 topic cases): spoken
 * yeses 0.96-0.98 on both; "no" and "wait, not yet" read as no on both. Jev
 * read an "okok" said to someone else just after the card as a yes, Luna did
 * not: the caller acts on a yes only after a 5 s spoken undo (lead-call.ts).
 */
export const ANSWER_PROBABILITY: PerProvider<number> = { openrouter: 0.6, openai: 0.5 };

/**
 * A piece is about the open topic at this probability. A decision's or a
 * reply's bar is higher, since being about it tags the words to the Lead with
 * its task: lines about a raised decision scored 0.80-0.98, "What's in flight
 * on the board?" 0.29 (Jev) and 0.66 (Luna) (live run 2026-11-05).
 */
export const ABOUT_PROBABILITY = { confirm: 0.5, decision: 0.75, reply: 0.75 } as const;

/**
 * A piece carries on from what the user was just saying to the Lead (the same
 * utterance, a pause between) at this probability.
 */
export const CONTINUE_PROBABILITY = 0.5;

const TOPIC_LABEL: Record<SpeechTopic["kind"], string> = {
	confirm: "a confirmation",
	decision: "a decision",
	reply: "a task's reply, just told to the user in one line",
};

const CALL = `The user is on a voice call with "the Lead", an AI that runs their software work: coding tasks, the board of tasks, the product's direction. The microphone in their room hears everything, not only the user talking to the Lead.`;

function questions(
	n: number,
	topic?: SpeechTopic,
	continuing = false,
): Record<string, YesNoQuestion> {
	const out: Record<string, YesNoQuestion> = {};
	for (let i = 0; i < n; i++) {
		const p = `piece_${i + 1}`;
		if (continuing)
			out[`${p}_continues`] = {
				instructions: `${CALL} The user was saying utterance_so_far to the Lead and paused. Is ${p} the user carrying on with it: the rest of the same sentence or thought, still said to the Lead, rather than turning to someone else or a sound from a TV?`,
			};
		if (topic) {
			out[`${p}_about`] = {
				instructions: `${CALL} The Lead just raised open_topic with the user. Is ${p} the user talking about open_topic: answering it, asking about it, or discussing it?`,
			};
			for (const [k] of (topic.options ?? []).slice(0, MAX_OPTIONS).entries())
				out[`${p}_opt_${k + 1}`] = {
					instructions: `${CALL} The Lead raised open_topic, whose answers are the options option_1, option_2 and so on. Does ${p} choose option_${k + 1} as the user's answer? Saying "go ahead", "yes", "do it" or "sounds good" chooses the recommended option (marked recommended), or the one that approves when none is. Asking about an option, thinking aloud, or being unsure ("not sure yet", "let me think") chooses none: being unsure is not the same as choosing an option such as "decide later", which the user chooses only by saying so.`,
				};
			if (topic.kind === "confirm") {
				out[`${p}_approve`] = {
					instructions: `${CALL} The Lead just asked the user to confirm open_topic. Does ${p} say yes to it: go ahead, send it, do it, approve it?`,
				};
				out[`${p}_refuse`] = {
					instructions: `${CALL} The Lead just asked the user to confirm open_topic. Does ${p} say no to it: don't, stop, wait, cancel, not now?`,
				};
			}
		}
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

/** A piece's yes or no to an open confirmation, from its probabilities. */
export function answerOf(
	p: { about: number; approve: number; refuse: number },
	bar: number,
): "approve" | "refuse" | null {
	if (p.about < 0.5) return null;
	// No is the safe direction: it wins a tie, and needs no higher bar than 0.5.
	if (p.refuse >= 0.5 && p.refuse >= p.approve) return "refuse";
	if (p.approve >= bar && p.approve > p.refuse) return "approve";
	return null;
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
 * At most MAX_PIECES pieces, every word kept: the oldest are joined into one.
 * Returns the pieces to judge and, per input piece, which one judges it.
 */
export function capPieces(pieces: string[]): { judged: string[]; of: number[] } {
	const extra = Math.max(0, pieces.length - MAX_PIECES);
	if (!extra) return { judged: pieces, of: pieces.map((_, i) => i) };
	return {
		judged: [pieces.slice(0, extra + 1).join(" "), ...pieces.slice(extra + 1)],
		of: pieces.map((_, i) => Math.max(0, i - extra)),
	};
}

/**
 * A verdict per piece of speech, in the order given. Null when there is
 * nothing to ask or the model did not answer in time: the caller decides.
 */
export async function judgeSpeech(input: {
	model: DecisionModel;
	/** What the call heard, in order, split at pauses. */
	pieces: string[];
	/** The call so far: the last turns, oldest first, one per line. */
	context: string;
	/** What the call just raised, if anything is open. */
	topic?: SpeechTopic;
	/** The user's words to the Lead just before, in the same utterance: a
	 *  piece that carries on from them is for the Lead too. */
	continuing?: string;
	/** The voice handed these words off as said to it: it hears the room (who
	 *  the user turns to, a TV's sound), which words alone don't carry. */
	handedOff?: boolean;
	signal?: AbortSignal;
}): Promise<SpeechVerdict[] | null> {
	if (!input.model.apiKey || input.pieces.length === 0) return null;
	const capped = capPieces(input.pieces);
	const judged = capped.judged.map((p) => p.slice(0, MAX_PIECE));
	const state: Record<string, string> = {
		call_so_far: input.context.slice(-MAX_CONTEXT) || "(nothing yet)",
	};
	judged.forEach((p, i) => {
		state[`piece_${i + 1}`] = p;
	});
	const topic = input.topic?.text.trim() ? input.topic : undefined;
	if (topic) state.open_topic = `${TOPIC_LABEL[topic.kind]}: ${topic.text.slice(0, MAX_PIECE)}`;
	if (input.continuing) state.utterance_so_far = input.continuing.slice(-MAX_PIECE);
	const options = (topic?.options ?? []).slice(0, MAX_OPTIONS);
	options.forEach((o, k) => {
		state[`option_${k + 1}`] =
			`${o.label}${o.recommended ? " (recommended)" : ""}${o.description ? `: ${o.description.slice(0, 200)}` : ""}`;
	});
	const answers = await askDecisions({
		target: input.model,
		model: CALL_GATE_MODEL[input.model.provider],
		state,
		questions: questions(judged.length, topic, !!input.continuing),
		timeoutMs: TIMEOUT_MS,
		signal: input.signal,
	});
	if (!answers) return null;
	const bar = input.handedOff
		? Math.min(SEND_PROBABILITY[input.model.provider], HANDED_OFF_PROBABILITY)
		: SEND_PROBABILITY[input.model.provider];
	const answerBar = ANSWER_PROBABILITY[input.model.provider];
	const chooseBar = CHOOSE_PROBABILITY[input.model.provider];
	const verdicts = judged.map((_, i): SpeechVerdict => {
		const a = (q: string) => answers[`piece_${i + 1}_${q}`] ?? 0;
		const said = verdictOf(
			{ lead: a("lead"), someone: a("someone"), background: a("background") },
			bar,
		);
		// The rest of what the user was saying to the Lead: for the Lead, even
		// when it reads as nothing alone (", legally we have to...").
		const v: SpeechVerdict =
			input.continuing && !said.send && a("continues") >= CONTINUE_PROBABILITY
				? { ...said, send: true, kind: "lead" }
				: said;
		if (!topic) return v;
		const about = a("about");
		return {
			...v,
			about,
			onTopic: about >= ABOUT_PROBABILITY[topic.kind],
			answer:
				topic.kind === "confirm"
					? answerOf({ about, approve: a("approve"), refuse: a("refuse") }, answerBar)
					: null,
			choice: options.length
				? choiceOf(
						about,
						options.map((_, k) => a(`opt_${k + 1}`)),
						chooseBar,
					)
				: null,
		};
	});
	return capped.of.map((k) => verdicts[k] as SpeechVerdict);
}
