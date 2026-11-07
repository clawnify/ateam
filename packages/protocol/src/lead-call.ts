// A voice call with the Lead. The call is with the Lead and lives in its chat:
// what the user says goes to the Lead as their message, and the Lead's reply
// is spoken. The voice is OpenAI's GPT-Live over WebRTC, its session opened by
// the machine whose key it is (server lead/call.ts): the Mac's main for the
// desktop, a box for Ateam Go, so the key never reaches the app. This engine
// is both apps' call; each gives it its mic, WebRTC and sounds (CallMedia).
//
// The mic hears the whole room: the user talking to someone else, other
// people, a TV. Only words said to the Lead may reach it, since the Lead acts
// on what it is told. So every utterance the call hears, split at pauses, is
// judged by the decision model (server call-gate.ts, fast and cheap)
// before anything is sent; what isn't sent shows in the call bar, with Send,
// and is never kept in the chat. The voice's own hand-off
// (`session.delegation.created`) only says when the user finished a turn and
// which hand-off the Lead's reply answers.
//
// A call is a state, not a connection. GPT-Live bills every second a session
// is open, silence included, so with nobody talking to the Lead and nothing
// pending the voice session closes and the call goes on hold: the mic stays on
// here, and speech, the Talk button, or something worth telling (a task
// replied, the Lead needs an approval) opens a new session seeded with the
// chat so far. OpenAI's own guidance for agents that work a long time is the
// same: close the voice during long work, reopen on a completion event (its
// "Voice latency and cost" guide).
//
// Known gap: words spoken while on hold, before the new session is up (about
// 1.5 s), are not heard. The chime says when it is listening again.
import {
	type AteamLead,
	CALL_MAX_PIECES,
	type LeadCallTopic,
	type LeadCallTurn,
	type LeadCallVerdict,
	type LeadEvent,
	type LeadItem,
} from "./lead";

export type CallState = "off" | "connecting" | "live" | "hold";

/** What a call needs of its Lead: the desktop's window.ateamLead and a box's
 *  Lead over RPC (LeadClient, protocol v33) both have it. */
export type CallLead = Pick<
	AteamLead,
	| "snapshot"
	| "onEvent"
	| "send"
	| "permission"
	| "answer"
	| "callStart"
	| "callJudge"
	| "callNudge"
	| "callActive"
>;

// The W3C WebRTC a call uses, as small as it is: the browser's and
// react-native-webrtc's both have it.
export interface CallTrack {
	enabled: boolean;
	stop(): void;
}
export interface CallStream {
	getAudioTracks(): CallTrack[];
	getTracks(): CallTrack[];
}
export interface CallChannel {
	readonly readyState: string;
	send(data: string): void;
	onmessage: ((m: { data: unknown }) => void) | null;
}
export interface CallPeer {
	readonly iceGatheringState: string;
	readonly localDescription: { sdp: string } | null;
	ontrack: ((e: { track: CallTrack }) => void) | null;
	addTrack(track: CallTrack, stream: CallStream): unknown;
	createDataChannel(label: string): CallChannel;
	createOffer(): Promise<{ type: string; sdp?: string }>;
	setLocalDescription(d: { type: string; sdp?: string }): Promise<void>;
	setRemoteDescription(d: { type: "answer"; sdp: string }): Promise<void>;
	addEventListener(type: "icegatheringstatechange", cb: () => void): void;
	removeEventListener(type: "icegatheringstatechange", cb: () => void): void;
	close(): void;
}

/** The mic's level while on hold, read by the call every 50 ms. */
export interface CallMeter {
	/** RMS, 0..1. */
	level(): number;
	stop(): void;
}

/** What the app a call runs in gives it. */
export interface CallMedia {
	/** The mic, with echo cancellation, noise suppression and gain control.
	 *  Asks for permission the first time; throws with words for the user. */
	openMic(): Promise<CallStream>;
	newPeer(): CallPeer;
	/** Plays the voice. React Native plays a remote track by itself. */
	play?(track: CallTrack): void;
	/** Measures the mic on hold, when no voice session has it: speech then
	 *  wakes the call. Stopped before a session opens again. */
	meter(mic: CallStream): CallMeter;
	/** Two short notes: the call hears you again. */
	chime(): void;
	/** The call ended: let go of what it held. Safe to call more than once. */
	close(): void;
}

/** Nothing for the Lead this long, the room quiet, nothing pending: hold. */
export const HOLD_AFTER_MS = 30_000;
/** Woken by a sound and nothing for the Lead this long since: a false wake, back to hold. */
export const FALSE_WAKE_MS = 10_000;
/** Talk that isn't for the Lead (a TV, a conversation in the room) keeps the
 *  session open at most this long after the last thing for the Lead. */
export const CHATTER_CAP_MS = 90_000;
/** The Lead working this long on what was said, nobody talking: hold anyway.
 *  Its reply reopens the call when it lands. */
export const PENDING_HOLD_MS = 60_000;
/** The Lead waiting on the user's tap (a permission card, a held message):
 *  hold once the call has been quiet this long, the card already announced. */
export const WAITING_HOLD_MS = 15_000;
/** How often the call tells the Lead it is still on (it lapses after
 *  90 s without, server lead/index.ts CALL_GUARD_MS). */
const CALL_BEAT_MS = 30_000;
/** This many false wakes within FALSE_WAKES_WINDOW_MS pause waking by sound. */
const FALSE_WAKES = 3;
const FALSE_WAKES_WINDOW_MS = 5 * 60_000;
const VOICE_WAKE_PAUSE_MS = 10 * 60_000;
/** A gap this long between transcript fragments, where a sentence ended,
 *  splits two pieces of speech. */
export const PIECE_GAP_MS = 800;
/**
 * No new words this long after some, and no hand-off: judge what was heard.
 * The voice's hand-off (judged at once) is the usual end of a turn: it hears
 * the room, and took a sentence said slowly, with 2.3 s pauses, as one turn,
 * handing it off 3 s after its last word. At 1.5 s this timer cut that
 * sentence at each pause, and its fragments, judged one by one, read as
 * nobody's (live, 2026-11-05). This is the fallback, for side talk and a
 * missed hand-off.
 */
export const QUIET_JUDGE_MS = 3_500;
/** A hand-off this soon after words went to the Lead without one is for them. */
const LATE_HAND_OFF_MS = 3_000;
/** Not sent, shown in the bar this long. */
const HELD_MS = 30_000;
/** A card the call raised (a confirmation) is what the user answers for this
 *  long after: a yes or a no then goes to the card, not to the Lead. */
export const CONFIRM_WINDOW_MS = 30_000;
/** A decision or a task's reply the call raised is what the user is talking
 *  about for this long after it, or after they last talked about it: their
 *  words to the Lead are tagged with its task. A decision is never answered
 *  from here unless the user clearly picks one of its buttons. */
export const DECISION_WINDOW_MS = 120_000;
/** A spoken yes acts this long after the voice says so: time to say stop. */
export const UNDO_MS = 5_000;
/** Mic level (RMS, 0..1) and duration that count as someone starting to talk on hold. */
const SPEECH_RMS = 0.03;
const SPEECH_MS = 250;
/** About 500 tokens, OpenAI's cap on one commentary append. */
const SPEAK_MAX = 1800;
/** What the voice is told about a request the gate sent, until its result. */
export const IN_PROGRESS =
	"In progress: this request is still being worked on and nothing is done yet. Say nothing about its outcome until its result comes.";

/** Markdown from the chat, as words to say aloud. */
export function speakable(md: string, max = SPEAK_MAX): string {
	let s = String(md ?? "")
		.replace(/```[\s\S]*?```/g, " (code in the chat) ")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)\1/g, "$2")
		.replace(/^\s{0,3}(#{1,6}|>)\s*/gm, "")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/\|/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (s.length <= max) return s;
	const cut = s.slice(0, max);
	const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
	s = end > max / 2 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, "")}…`;
	return `${s} The rest is in the chat.`;
}

/** The chat so far as a call session's starting history. */
export function turnsFrom(items: LeadItem[]): LeadCallTurn[] {
	const turns: LeadCallTurn[] = [];
	for (const it of items) {
		if (it.kind === "user")
			turns.push({
				role: "user",
				text: it.to ? `(to the task "${it.to.name}") ${it.text}` : it.text,
			});
		else if (it.kind === "assistant")
			turns.push({ role: "assistant", text: speakable(it.text, 4000) });
		else if (it.kind === "agent")
			turns.push({
				role: "developer",
				text: `The task "${it.task.name}" replied: ${speakable(it.text, 1500)}`,
			});
	}
	return turns;
}

/**
 * A message for the gate's context: whole when short, else its start and its
 * end. The end is where a message asks what the user is answering: a Lead
 * message cut to its first 300 characters lost "can it stop the simulator?",
 * and the user's answer to it was held as not for the Lead (2026-11-05).
 */
export function gist(md: string, max: number): string {
	const s = speakable(md, Number.POSITIVE_INFINITY);
	if (s.length <= max) return s;
	const head = Math.round(max / 3);
	const start = s.slice(0, head).replace(/\s+\S*$/, "");
	const end = s.slice(s.length - (max - head)).replace(/^\S*\s+/, "");
	return `${start} … ${end}`;
}

/** Something the call heard and held back, remembered for the gate's context
 *  for a while (in memory only, never stored). */
export interface HeardAside {
	text: string;
	kind: LeadCallVerdict["kind"];
	at: number;
}

/** Asides older than this no longer tell the gate anything about what comes next. */
export const ASIDE_MEMORY_MS = 2 * 60_000;

const ago = (ms: number) => {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
};

/** A line the call said on its own, never in the chat: a task's reply in one
 *  line, a decision raised, a card announced. */
export interface SpokenLine {
	text: string;
	at: number;
}

/**
 * The last few turns, for the gate to judge what it heard against: the chat
 * with the Lead, the tasks' replies, what the voice said on its own and what
 * the call held back, in time order, each with its age. All of it is what the
 * user may be answering. Measured: a bare "okok" after the Lead asked "Should
 * I go ahead?" went to the Lead (Jev 0.83-0.87, Luna 0.97) even when it
 * answered a question the user had just asked someone else; told that "Did
 * you give food to the cat?" was said to someone 4 s ago and the Lead asked 25
 * s ago, both held it (0.28-0.38), and still sent it when the Lead had just
 * asked. Without the replies and the voice's own lines, "What network
 * issues?", asked about a reply the voice had just summed up, was held as said
 * to someone else (2026-11-05).
 */
export function contextFrom(
	items: LeadItem[],
	heard: { asides?: HeardAside[]; said?: SpokenLine[] } = {},
	now = Date.now(),
	turns = 8,
): string {
	const lines: { at: number; line: string }[] = [];
	for (const it of items) {
		if (it.kind === "user" && !it.to)
			lines.push({ at: it.at, line: `user (${ago(now - it.at)}): ${gist(it.text, 300)}` });
		else if (it.kind === "assistant")
			lines.push({ at: it.at, line: `lead (${ago(now - it.at)}): ${gist(it.text, 700)}` });
		else if (it.kind === "agent")
			lines.push({
				at: it.at,
				line: `the task "${it.task.name}" replied (${ago(now - it.at)}): ${gist(it.text, 500)}`,
			});
	}
	for (const s of heard.said ?? [])
		lines.push({ at: s.at, line: `lead, said on the call (${ago(now - s.at)}): ${s.text}` });
	for (const a of heard.asides ?? []) {
		if (now - a.at > ASIDE_MEMORY_MS) continue;
		const what =
			a.kind === "someone"
				? ", said to someone else in the room"
				: a.kind === "background"
					? ", from a TV or someone nearby"
					: "";
		lines.push({
			at: a.at,
			line: `heard, not sent to the Lead (${ago(now - a.at)})${what}: "${a.text.slice(0, 200)}"`,
		});
	}
	return lines
		.sort((a, b) => a.at - b.at)
		.slice(-turns)
		.map((l) => l.line)
		.join("\n");
}

/** What to tell the user about something new in the chat they didn't ask for
 *  on this call, or null when it isn't worth interrupting for. In the first
 *  person: the voice is the Lead (server lead/call.ts CALL_INSTRUCTIONS). */
export function announcement(item: LeadItem): string | null {
	switch (item.kind) {
		// A task's reply is said as one short line, written by the text model
		// (LeadCall.nudge): this is only what to say if that never comes.
		case "agent":
			return `The task "${item.task.name}" replied. It's in the chat.`;
		case "page":
			return `Update: the task "${item.task.name}" put a page in the chat, "${item.title}".`;
		case "permission":
			return item.answer
				? null
				: `I need your OK in the chat for this: ${speakable(item.text, 300)}`;
		case "proposal":
			return item.outcome
				? null
				: `I've proposed a ${item.proposal.kind}, "${item.proposal.name}". It's waiting in the chat for you to create it.`;
		case "notice":
			return item.tone === "error" ? `Something went wrong on my side: ${item.text}` : null;
		default:
			return null;
	}
}

/** A transcript fragment, on the session's audio clock. */
export interface Fragment {
	text: string;
	start: number;
	end: number;
}

/** A sentence's end, as the transcript marks it: not "..." or "…", which
 *  trail off mid-thought. */
const SENTENCE_END = /(?:^|[^.])[.?!。？！]$/;
const LEADING_END = /^\s*(?:[?!。？！]+|\.(?!\.))/;

/**
 * Fragments as pieces of speech: split at a pause where a sentence ended, so
 * side talk and a request said in one breath are judged apart ("Mom, hold on
 * a second." / "Delete the old box."), and a sentence with pauses in it is
 * judged whole (a pause alone split "In the web project, send a task to
 * check..." into fragments that each read as nobody's). The transcript puts a
 * sentence's end mark at the start of the next fragment (". Delete"). Past
 * `max` pieces, the oldest are joined into one, so every word is judged.
 */
export function piecesOf(frags: Fragment[], gapMs = PIECE_GAP_MS, max = CALL_MAX_PIECES): string[] {
	const pieces: string[] = [];
	let cur = "";
	let lastEnd = Number.NEGATIVE_INFINITY;
	for (const f of frags) {
		let text = f.text;
		// Punctuation can arrive late, timed with the next words ("?" after a
		// question): it ends the piece before it, never starts one.
		if (/^[\p{P}\s]*$/u.test(text)) {
			if (cur) cur += text;
			else if (pieces.length) pieces[pieces.length - 1] += text;
			continue;
		}
		const mark = text.match(LEADING_END)?.[0];
		if (cur && f.start - lastEnd >= gapMs && (mark || SENTENCE_END.test(cur.trimEnd()))) {
			if (mark) {
				cur += mark.trim();
				text = text.slice(mark.length);
			}
			pieces.push(cur);
			cur = "";
		}
		cur += text;
		lastEnd = f.end;
	}
	if (cur) pieces.push(cur);
	const out = pieces.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
	const extra = out.length - max;
	return extra > 0 ? [out.slice(0, extra + 1).join(" "), ...out.slice(extra + 1)] : out;
}

/** Speech with pauses shorter than this is one utterance, even when it was
 *  judged in several goes: the voice handing off at a pause, or a pause past
 *  QUIET_JUDGE_MS, which only a gap longer than it can span (at 3 s it never
 *  did, the quiet timer being 3.5 s). */
export const UTTERANCE_GAP_MS = QUIET_JUDGE_MS + 2_500;

/** A piece of speech after the gate: for the Lead, or held back and why. */
export interface Judged {
	text: string;
	lead: boolean;
	kind: LeadCallVerdict["kind"];
}

/** An utterance so far, across judgements: whether any of it went to the
 *  Lead, and what of it is held as nobody's (whole held lines, as shown). */
export interface Utterance {
	sent: boolean;
	held: string[];
}

/** The longest stretch of a held utterance judged again with what follows. */
const CARRY_MAX = 600;

/**
 * The pieces to judge in a new go of an utterance. A slow speaker's pauses
 * cut a sentence into goes, and each fragment alone reads as nobody's: Jev put
 * every fragment of "In the web project / send a task / to check / ..." at
 * 0.53-0.67, under its bar, and none reached the Lead (live run 2026-11-05).
 * So while the utterance so far is held as nobody's, it is judged again with
 * what came next, as one piece: the sentence, not its fragments.
 */
export function withCarry(
	pieces: string[],
	earlier: Utterance | null,
): { pieces: string[]; carried: string[] } {
	const carried = earlier && !earlier.sent ? earlier.held : [];
	if (!carried.length || !pieces.length) return { pieces, carried: [] };
	const first = `${carried.join(" ")} ${pieces[0]}`.slice(-CARRY_MAX);
	return { pieces: [first, ...pieces.slice(1)], carried };
}

/**
 * What of a judgement goes to the Lead. A pause can fall mid-sentence, and a
 * fragment alone reads as nobody's: a sentence reached the Lead as "to check",
 * with "instructions" held (2026-11-05). So when a piece is for the Lead, the
 * pieces judged with it that read as nobody's (unclear) go too, in order. What
 * reads as said to someone else or as a TV stays back: that is what the gate
 * is for. Across judgements only the gate's own answer carries words on
 * (`continuing`, judgeSpeech): a gate that gave none can't tell a TV line from
 * the rest of a sentence (Luna refuses to judge some news lines at all).
 */
export function rideAlong(pieces: Judged[]): { lead: string[]; held: Judged[] } {
	if (!pieces.some((p) => p.lead)) return { lead: [], held: pieces };
	return {
		lead: pieces.filter((p) => p.lead || p.kind === "unclear").map((p) => p.text),
		held: pieces.filter((p) => !p.lead && p.kind !== "unclear"),
	};
}

/** Whether a live call should go on hold now. */
export function shouldHold(s: {
	now: number;
	/** The last thing for the Lead: words sent to it, the voice speaking, a wake. */
	engagedAt: number;
	/** The last words heard at all, for the Lead or not. */
	heardAt: number;
	/** Woken by a sound, and nothing for the Lead since. */
	falseWake: boolean;
	/** Words went to the Lead and its turn hasn't ended. */
	pending?: boolean;
	/** The Lead waits on the user's tap: a permission card, a held message. */
	waitingOnUser?: boolean;
	/** Words heard and not judged yet: a quiet room holds only after they are
	 *  (QUIET_JUDGE_MS), so the last words before a hold reach the gate. */
	unjudged?: boolean;
}): boolean {
	const idle = s.now - s.engagedAt;
	const quiet = s.now - s.heardAt;
	// Endless talk that isn't for the Lead (a TV): on hold whatever is pending.
	if (idle > CHATTER_CAP_MS) return true;
	if (s.unjudged) return false;
	// Waiting on the Lead is no reason to bill silence forever: not while it
	// waits on the user, nor through a long turn. Its reply reopens the call.
	if (s.pending)
		return quiet > 3_000 && (s.waitingOnUser ? idle > WAITING_HOLD_MS : idle > PENDING_HOLD_MS);
	if (s.falseWake && idle > FALSE_WAKE_MS && quiet > 1_500) return true;
	return idle > HOLD_AFTER_MS && quiet > 3_000;
}

/** The Lead waits on the user's tap: a permission card nobody answered. */
export function waitingOnUser(items: LeadItem[]): boolean {
	return items.some((i) => i.kind === "permission" && !i.answer);
}

/** Why something heard wasn't sent, in the user's words. */
export function heldReason(kind: LeadCallVerdict["kind"]): string {
	if (kind === "someone") return "sounded like you were talking to someone else";
	if (kind === "background") return "sounded like a TV or someone nearby";
	return "not sure it was for the Lead";
}

/** A card, a decision or a task's reply the call raised, while it is still
 *  what the user may be answering or talking about. */
export type OpenTopic =
	| { kind: "confirm"; id: string; text: string; at: number }
	| {
			kind: "decision";
			taskId: string;
			questionId: string;
			name: string;
			text: string;
			/** Its buttons, when one may be picked by voice (not a checklist). */
			options: CallOption[];
			at: number;
	  }
	/** A task's reply, said in one line: words about it reach the Lead tagged
	 *  with the task, which only learns what a task said by reading it. */
	| { kind: "reply"; taskId: string; name: string; text: string; at: number };

/** A topic a spoken yes, or a button picked by voice, acts on. */
type Answerable = Exclude<OpenTopic, { kind: "reply" }>;

/** What the gate judges the next words against: a pending approval first (a
 *  "stop" cancels it), then a card raised in the last 30 s, then a decision
 *  or a task's reply raised or discussed in the last 2 min. */
export function activeTopic(
	now: number,
	open: OpenTopic | null,
	approving: { text: string } | null,
): (LeadCallTopic & { open: OpenTopic | null }) | null {
	if (approving)
		return { kind: "confirm", text: `about to go ahead: ${approving.text}`, open: null };
	if (!open) return null;
	const window = open.kind === "confirm" ? CONFIRM_WINDOW_MS : DECISION_WINDOW_MS;
	if (now - open.at > window) return null;
	return open.kind === "decision" && open.options.length
		? { kind: open.kind, text: open.text, options: open.options, open }
		: { kind: open.kind, text: open.text, open };
}

/** A task's question, told once on a call: a decision, with time to think. */
export function decisionLine(task: string, question: string): string {
	const title = speakable(
		String(question ?? "")
			.split("\n")
			.find((l) => l.trim()) ?? "",
		220,
	);
	return `The task "${task}" needs a decision from you${title ? `: ${title}` : ""}. It's waiting in the chat, so take your time. Want me to walk you through it?`;
}

/** A decision's button, as the gate and the call see it. */
export interface CallOption {
	label: string;
	recommended?: boolean;
	description?: string;
}

/** A task as the call needs it: its open question, with its buttons. */
export interface CallTask {
	id: string;
	name: string;
	question?: {
		id: string;
		text: string;
		options: string[];
		choices?: CallOption[];
		select?: "one" | "many";
	} | null;
}

/** A question's buttons the user may pick by voice: none for a checklist. */
export function optionsOf(q: NonNullable<CallTask["question"]>): CallOption[] {
	if (q.select === "many") return [];
	if (q.choices?.length)
		return q.choices.map((c) => ({
			label: c.label,
			...(c.recommended ? { recommended: true } : {}),
			...(c.description ? { description: c.description } : {}),
		}));
	return q.options.map((label) => ({ label }));
}

export interface CallView {
	state: CallState;
	/** Words for the user when the last attempt failed. */
	error: string;
	muted: boolean;
	/** Heard but not sent to the Lead: shown with Send, never kept. */
	held: { text: string; kind: LeadCallVerdict["kind"] } | null;
	/** Too many false wakes: speech won't pick up the call for a while. */
	voiceWakePaused: boolean;
	/** A spoken yes to a card, acting in UNDO_MS unless the user says stop or taps Undo. */
	approving: { text: string } | null;
	/** A phone call has the mic (the system holds this call): on hold until it's back. */
	paused: boolean;
}

/** The chat a call reads when it starts or reconnects: enough for the voice's
 *  starting history (server lead/call.ts keeps at most 128 turns), without
 *  sending a phone a long conversation whole. */
const SNAPSHOT_TAIL = 400;

export class LeadCall {
	view: CallView = {
		state: "off",
		error: "",
		muted: false,
		held: null,
		voiceWakePaused: false,
		approving: null,
		paused: false,
	};
	private listeners = new Set<() => void>();
	private mic: CallStream | null = null;
	private pc: CallPeer | null = null;
	private dc: CallChannel | null = null;
	private started: (() => void) | null = null;
	private closed: (() => void) | null = null;
	/** The mic's level, while on hold. */
	private meter: CallMeter | null = null;
	private vadTimer: ReturnType<typeof setInterval> | null = null;
	private tickTimer: ReturnType<typeof setInterval> | null = null;
	private judgeTimer: ReturnType<typeof setTimeout> | null = null;
	private heldTimer: ReturnType<typeof setTimeout> | null = null;
	private unsub: (() => void) | null = null;
	private items: LeadItem[] = [];
	private seen = new Set<string>();
	/** Heard and not judged yet. */
	private frags: Fragment[] = [];
	/** Held back lately: the gate weighs what comes next against them. */
	private asides: HeardAside[] = [];
	/** The utterance the last judgement ended, until when it was heard. */
	private utter: (Utterance & { until: number; text: string }) | null = null;
	/** When the first words of the batch now being heard came in. */
	private batchFrom = 0;
	/** The voice's own last lines (say), for the gate's context. */
	private said: SpokenLine[] = [];
	/** The card, decision or reply the call raised last, while it may be the topic. */
	private topic: OpenTopic | null = null;
	/** A spoken yes, or an option picked by voice, counting down to acting. */
	private approval: { open: Answerable; timer: ReturnType<typeof setTimeout> } | null = null;
	/** Tasks and their open questions, from the chat's window (setTasks). */
	private tasks: CallTask[] = [];
	/** Questions already told on this call, or there before it began. */
	private toldQuestions = new Set<string>();
	/** Hand-offs waiting on the Lead's turn, oldest first; null for words the
	 *  gate sent without one. */
	private pending: (string | null)[] = [];
	/** The Lead's text in the turn answering them, by item id. */
	private reply = new Map<string, string>();
	/** Said while no session was open: told once one is. */
	private queued: string[] = [];
	private engagedAt = 0;
	private heardAt = 0;
	/** When words last went to the Lead. */
	private sentAt = 0;
	/** When the Lead was last told the call is on. */
	private beatAt = 0;
	private wokeBySound = false;
	private sentSinceWake = false;
	private falseWakes: number[] = [];
	private voiceWakeOffUntil = 0;
	private loudSince = 0;
	private n = 0;

	/** How a task's question is answered: the chat's own way (answerWith), so a
	 *  voice pick reaches a task the way a tap on its card does. */
	private answerTask: (input: Parameters<CallLead["answer"]>[0]) => Promise<void> = (input) =>
		this.lead().answer(input);

	constructor(
		private readonly lead: () => CallLead,
		private readonly media: CallMedia,
	) {}

	/** The chat's way to answer a task's question (LeadChat: a box's Lead can't
	 *  reach a task elsewhere, which is answered directly). */
	answerWith(fn: (input: Parameters<CallLead["answer"]>[0]) => Promise<void>): void {
		this.answerTask = fn;
	}

	get state(): CallState {
		return this.view.state;
	}

	subscribe(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}
	private update(patch: Partial<CallView>): void {
		this.view = { ...this.view, ...patch };
		for (const cb of this.listeners) cb();
	}

	/** Bumped by hangUp: a start still on its way stops where it is. */
	private gen = 0;

	/** From a click: the mic asks for permission now. */
	async start(): Promise<void> {
		if (this.state !== "off") return;
		const gen = ++this.gen;
		// Hung up while starting (a phone's start waits on the system call and
		// the box): go no further, and it was no error.
		const hungUp = () => gen !== this.gen;
		this.update({ state: "connecting", error: "", held: null, muted: false });
		try {
			// First: a chat that can't hold its Lead's messages for a tap (a box
			// too old) gets no call at all.
			await this.lead().callActive(true);
			if (hungUp()) return;
			this.beatAt = Date.now();
			const snap = await this.lead().snapshot({ tail: SNAPSHOT_TAIL });
			if (hungUp()) return;
			this.items = snap.items;
			this.seen = new Set(snap.items.map((i) => i.id));
			// Warm the decision model: its first call of a session is the slow one.
			void this.lead()
				.callJudge(["Hello."], "")
				.catch(() => null);
			const mic = await this.media.openMic();
			if (hungUp()) {
				for (const t of mic.getTracks()) t.stop();
				this.media.close();
				return;
			}
			this.mic = mic;
			// Decisions already waiting are told as a count, once; new ones one by one.
			this.toldQuestions = new Set(this.tasks.flatMap((t) => (t.question ? [t.question.id] : [])));
			const waiting = this.toldQuestions.size;
			if (waiting)
				this.queued.push(
					`${waiting === 1 ? "One decision is" : `${waiting} decisions are`} waiting on you in the chat, whenever you're ready.`,
				);
			this.unsub = this.lead().onEvent((e) => this.onLead(e));
			this.listen();
			this.tickTimer = setInterval(() => this.tick(), 1000);
			this.wokeBySound = false;
			await this.open();
		} catch (e) {
			if (!hungUp()) this.hangUp(words(e));
		}
	}

	/** End the call: the voice session, the mic, the listening. */
	hangUp(error = ""): void {
		this.gen++;
		if (this.state !== "off")
			void this.lead()
				.callActive(false)
				.catch(() => {});
		void this.closeSession();
		for (const t of this.mic?.getTracks() ?? []) t.stop();
		this.mic = null;
		this.unsub?.();
		this.unsub = null;
		for (const t of [this.vadTimer, this.tickTimer]) if (t) clearInterval(t);
		for (const t of [this.judgeTimer, this.heldTimer]) if (t) clearTimeout(t);
		this.vadTimer = this.tickTimer = this.judgeTimer = this.heldTimer = null;
		this.stopMeter();
		this.media.close();
		this.pending = [];
		this.reply.clear();
		this.queued = [];
		this.frags = [];
		this.asides = [];
		this.said = [];
		this.utter = null;
		this.topic = null;
		// Hanging up mid-countdown: nothing acts on a yes the user can't take back.
		this.stopApproval(false);
		this.update({
			state: "off",
			error,
			held: null,
			muted: false,
			approving: null,
			paused: false,
		});
	}

	/** A phone call took the mic (the system put this call on hold), or gave it
	 *  back. Meanwhile no voice session opens and nothing listens; what the
	 *  call would have said waits, and is said when the call is back. */
	setPaused(paused: boolean): void {
		if (this.state === "off" || this.view.paused === paused) return;
		this.update({ paused });
		if (paused) {
			this.stopMeter();
			if (this.state !== "hold") void this.toHold();
		} else if (this.queued.length) this.wake();
		else this.hearOnHold();
	}

	/** The Lead's connection was replaced (a box reconnected, the phone changed
	 *  networks): listen on the new one, and catch up on what came meanwhile. */
	relink(): void {
		if (this.state === "off") return;
		this.unsub?.();
		this.unsub = this.lead().onEvent((e) => this.onLead(e));
		// A box pushes events once the connection has made a call, and its call
		// guard lapses without a beat.
		this.beatAt = Date.now();
		void this.lead()
			.callActive(true)
			.catch(() => {});
		void this.lead()
			.snapshot({ tail: SNAPSHOT_TAIL })
			.then(
				(s) => {
					if (this.state === "off") return;
					for (const item of s.items)
						if (!this.seen.has(item.id)) this.onLead({ type: "item", item });
					if (!s.busy && this.pending.length) this.onLead({ type: "busy", busy: false });
				},
				() => {},
			);
	}

	/** Nothing from the mic leaves this device while muted. */
	setMuted(muted: boolean): void {
		for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = !muted;
		this.update({ muted });
	}

	/** The Talk button on hold: pick the call up. */
	talk(): void {
		this.wokeBySound = false;
		this.voiceWakeOffUntil = 0;
		this.update({ voiceWakePaused: false });
		this.wake();
	}

	/** The tasks the chat's window shows, for their open questions: a new one
	 *  is told on the call once, as a decision to think about. */
	setTasks(tasks: CallTask[]): void {
		this.tasks = tasks;
		if (this.state === "off") return;
		// Answered elsewhere (a tap, the board): no longer the topic.
		const was = this.topic;
		if (was?.kind === "decision" && !tasks.some((t) => t.question?.id === was.questionId)) {
			this.topic = null;
			if (this.approval?.open === was) this.stopApproval(false);
		}
		for (const t of tasks) {
			const q = t.question;
			if (!q || this.toldQuestions.has(q.id)) continue;
			this.toldQuestions.add(q.id);
			this.topic = {
				kind: "decision",
				taskId: t.id,
				questionId: q.id,
				name: t.name,
				text: speakable(q.text, 600),
				options: optionsOf(q),
				at: Date.now(),
			};
			this.say(decisionLine(t.name, q.text));
		}
	}

	/** Undo a spoken yes before it acts: the card stays waiting in the chat. */
	undo(): void {
		this.stopApproval(true);
	}

	/** Send what was held back after all: the user says it was for the Lead. */
	sendHeld(): void {
		const held = this.view.held;
		if (!held) return;
		// It was for the Lead after all: not an aside for the gate to weigh.
		this.asides = this.asides.filter((a) => a.text !== held.text);
		this.update({ held: null });
		this.toLead(null, held.text);
	}

	// ---- the voice session ------------------------------------------------------

	private async open(): Promise<void> {
		if (!this.mic) return;
		this.update({ state: "connecting" });
		// The session takes the mic from here (on a phone, from the meter).
		this.stopMeter();
		const pc = this.media.newPeer();
		this.pc = pc;
		pc.ontrack = (e) => this.media.play?.(e.track);
		for (const t of this.mic.getAudioTracks()) pc.addTrack(t, this.mic);
		const dc = pc.createDataChannel("oai-events");
		this.dc = dc;
		dc.onmessage = (m) => {
			try {
				this.onVoice(JSON.parse(String(m.data)));
			} catch {
				/* not JSON: ignore */
			}
		};
		const ready = new Promise<void>((resolve, reject) => {
			this.started = resolve;
			setTimeout(() => reject(new Error("The call didn't connect.")), 20_000);
		});
		await pc.setLocalDescription(await pc.createOffer());
		await iceGathered(pc);
		const sdp = pc.localDescription?.sdp ?? "";
		const answer = await this.lead().callStart(sdp, turnsFrom(this.items));
		if (this.pc !== pc) return; // hung up meanwhile
		await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
		await ready;
		if (this.pc !== pc) return;
		this.engagedAt = Date.now();
		this.sentSinceWake = false;
		this.update({ state: "live", error: "" });
		for (const text of this.queued.splice(0)) this.send("session.commentary.append", null, text);
	}

	/** Close the session only (the call stays on): ask OpenAI to close, wait for it. */
	private async closeSession(): Promise<void> {
		const pc = this.pc;
		const dc = this.dc;
		this.pc = this.dc = null;
		this.started = null;
		this.frags = [];
		if (!pc) return;
		if (dc?.readyState === "open") {
			const done = new Promise<void>((r) => {
				this.closed = r;
				setTimeout(r, 3000);
			});
			dc.send(JSON.stringify({ type: "session.close", event_id: this.id("close") }));
			await done;
		}
		this.closed = null;
		pc.close();
	}

	private async toHold(): Promise<void> {
		if (this.wokeBySound && !this.sentSinceWake) this.falseWake();
		this.update({ state: "hold" });
		// Closing drops what was heard and not judged: judge it first (only
		// the chatter cap holds before the quiet timer has).
		if (this.frags.length) {
			if (this.judgeTimer) clearTimeout(this.judgeTimer);
			this.judgeTimer = null;
			const handOff = this.pendingHandOff;
			this.pendingHandOff = null;
			void this.judge(handOff);
		}
		await this.closeSession();
		this.hearOnHold();
	}

	/** On hold no session has the mic: its level is what wakes the call. */
	private hearOnHold(): void {
		if (this.state !== "hold" || this.view.paused || !this.mic || this.meter) return;
		try {
			this.meter = this.media.meter(this.mic);
		} catch (e) {
			// Without a meter, Talk and the call's own news still wake it.
			console.warn("[lead-call] no mic level on hold:", e);
		}
	}

	private stopMeter(): void {
		this.meter?.stop();
		this.meter = null;
	}

	/** A sound woke the call and nothing for the Lead came of it. Too many in a
	 *  row (a TV, a busy room): stop waking by sound for a while. */
	private falseWake(): void {
		const now = Date.now();
		this.falseWakes = [...this.falseWakes.filter((t) => now - t < FALSE_WAKES_WINDOW_MS), now];
		if (this.falseWakes.length >= FALSE_WAKES) {
			this.falseWakes = [];
			this.voiceWakeOffUntil = now + VOICE_WAKE_PAUSE_MS;
			this.update({ voiceWakePaused: true });
		}
	}

	/** Reopen from hold, with a chime so the user knows it hears them again. */
	private wake(): void {
		if (this.state !== "hold" || this.view.paused) return;
		this.media.chime();
		const gen = this.gen;
		this.open().catch((e) => {
			if (gen !== this.gen) return; // hung up meanwhile
			// Couldn't reopen: stay on hold and say why.
			this.update({ state: "hold", error: words(e) });
			void this.closeSession().then(() => this.hearOnHold());
		});
	}

	private send(type: string, delegationId: string | null, content: string): void {
		if (this.dc?.readyState !== "open") {
			if (type === "session.commentary.append") {
				this.queued.push(content);
				this.wokeBySound = false;
				this.wake();
			}
			return;
		}
		this.dc.send(
			JSON.stringify({ type, event_id: this.id("c"), delegation_id: delegationId, content }),
		);
		if (type === "session.commentary.append") this.engagedAt = Date.now();
	}

	private id(p: string): string {
		return `${p}_${Date.now()}_${++this.n}`;
	}

	private onVoice(ev: { type: string; [k: string]: unknown }): void {
		switch (ev.type) {
			case "session.started":
				this.started?.();
				break;
			case "session.input_transcript.delta":
				if (!this.frags.length) this.batchFrom = Date.now();
				this.frags.push({
					text: String(ev.delta ?? ""),
					start: Number(ev.start_ms ?? 0),
					end: Number(ev.end_ms ?? 0),
				});
				this.heardAt = Date.now();
				this.judgeSoon(QUIET_JUDGE_MS);
				break;
			case "session.output_transcript.delta":
				// Not the end of the user's turn: the voice says "Sure." over a
				// pause and the user goes on. Judging then cut a sentence in two
				// (live, 2026-11-05); the hand-off or the quiet timer ends a turn.
				this.engagedAt = Date.now();
				break;
			case "session.delegation.created": {
				const id = String((ev.delegation as { id?: string } | undefined)?.id ?? "");
				// Cancel the voice's automatic acknowledgement (an empty thinking
				// append does, OpenAI's delegation guide): it comes before the gate
				// rules, and promised "Okay, I'll take care of that." for words the
				// gate then held, instructions or not (live, 2026-11-05). The call
				// acknowledges once the words went (judgeBatch), and a yes to a card
				// is never heard as taken.
				this.send("session.thinking.append", id, "");
				// The last words' transcript can land just after the hand-off.
				this.judgeSoon(400, id);
				break;
			}
			case "session.closed":
				this.closed?.();
				// OpenAI ended it (its time limit, a dropped line): on hold, not off.
				// It is gone already: nothing to ask it or wait for (a close request
				// went unanswered for 3 s, and wake by voice waited on it, live).
				if (this.state === "live") {
					this.update({ state: "hold" });
					this.dc = null;
					void this.closeSession().then(() => this.hearOnHold());
				}
				break;
			case "error":
				console.warn("[lead-call]", ev);
				break;
		}
	}

	/** Judge what was heard in `ms`, unless more words come first. A hand-off
	 *  is never dropped by a later reschedule. */
	private pendingHandOff: string | null = null;
	private judgeSoon(ms: number, handOff?: string): void {
		if (handOff) this.pendingHandOff = handOff;
		if (this.judgeTimer) clearTimeout(this.judgeTimer);
		this.judgeTimer = setTimeout(() => {
			this.judgeTimer = null;
			const id = this.pendingHandOff;
			this.pendingHandOff = null;
			void this.judge(id);
		}, ms);
	}

	/** The gate: only words the decision model puts as said to the Lead go to
	 *  it, and a yes or no to the card the call just raised goes to that card. */
	/** Judge what was heard so far, after any judgement still running: each
	 *  one weighs the utterance as the one before it left it. */
	private judging: Promise<void> = Promise.resolve();
	private judge(handOff: string | null): Promise<void> {
		const batch = { frags: this.frags, from: this.batchFrom, until: this.heardAt };
		this.frags = [];
		const run = this.judging.then(() => this.judgeBatch(batch, handOff));
		this.judging = run.catch(() => {});
		return run;
	}

	private async judgeBatch(
		batch: { frags: Fragment[]; from: number; until: number },
		handOff: string | null,
	): Promise<void> {
		const pieces = piecesOf(batch.frags);
		if (!pieces.length) {
			if (handOff) this.lateHandOff(handOff);
			return;
		}
		const topic = activeTopic(Date.now(), this.topic, this.view.approving);
		// The same utterance as the last judgement, after a short pause: what of
		// it is held is judged again with these words, so no longer held alone.
		const earlier =
			this.utter && batch.from - this.utter.until < UTTERANCE_GAP_MS ? this.utter : null;
		const carry = withCarry(pieces, earlier);
		if (carry.carried.length) {
			this.asides = this.asides.filter((a) => !carry.carried.includes(a.text));
			if (this.view.held && carry.carried.includes(this.view.held.text))
				this.update({ held: null });
		}
		const verdicts = await this.lead()
			.callJudge(carry.pieces, contextFrom(this.items, { asides: this.asides, said: this.said }), {
				...(topic
					? {
							topic: {
								kind: topic.kind,
								text: topic.text,
								...(topic.options ? { options: topic.options } : {}),
							},
						}
					: {}),
				...(earlier?.sent ? { continuing: earlier.text } : {}),
				handedOff: !!handOff,
			})
			.catch(() => null);
		// No decision model (no key, turned off) or no answer in time: trust the
		// voice's hand-off, and hold back what it didn't hand off. Cards are then
		// answered only by tap.
		const out: Judged[] = [];
		let answered = false;
		for (const [i, text] of carry.pieces.entries()) {
			const v = verdicts?.[i];
			if (v?.answer && this.approval) {
				// The only answer to a countdown that matters is stop.
				if (v.answer === "refuse") {
					this.stopApproval(true, handOff);
					answered = true;
				}
				continue;
			}
			const open = topic?.open;
			// A decision's button picked by voice ("go ahead" is its recommended
			// option): only on a clear pick, and after the undo countdown.
			const picked =
				open?.kind === "decision" && v?.choice != null ? open.options[v.choice] : undefined;
			if (open?.kind === "decision" && picked) {
				answered = true;
				this.startApproval(open, handOff, picked.label);
				continue;
			}
			if (v?.answer && open?.kind === "confirm") {
				answered = true;
				if (v.answer === "approve") {
					this.startApproval(open, handOff);
					continue;
				}
				// A no acts at once, and its words still reach the Lead: they may
				// carry a correction ("make it formal instead").
				this.topic = null;
				void this.lead()
					.permission(open.id, "deny")
					.catch(() => {});
				if (!v.send) {
					this.send("session.commentary.append", handOff, "Okay, I won't.");
					continue;
				}
			}
			if (v ? v.send : !!handOff) {
				// Talking about a decision or a reply the call raised: the Lead hears
				// which task (it reads the task for what it said).
				if (v?.onTopic && (open?.kind === "decision" || open?.kind === "reply")) {
					this.topic = { ...open, at: Date.now() };
					const tag = `[${open.name.replace(/[[\]\n]/g, " ")}](task:${open.taskId})`;
					out.push({ text: `${tag} ${text}`, lead: true, kind: "lead" });
				} else out.push({ text, lead: true, kind: v?.kind ?? "lead" });
			} else out.push({ text, lead: false, kind: v?.kind ?? "unclear" });
		}
		const plan = rideAlong(out);
		// Everything held, together: the bar's Send sends all of it.
		const held = plan.held.length
			? {
					text: plan.held.map((h) => h.text).join(" "),
					kind: plan.held.every((h) => h.kind === plan.held[0]?.kind)
						? (plan.held[0]?.kind ?? "unclear")
						: "unclear",
				}
			: null;
		if (held) this.hold(held);
		this.utter = {
			until: batch.until,
			sent: !!earlier?.sent || plan.lead.length > 0,
			text: [earlier?.sent ? earlier.text : "", ...plan.lead].join(" ").trim().slice(-600),
			// Only what was held as nobody's is judged again with what follows
			// (the carried part is already in it).
			held: !plan.lead.length && held?.kind === "unclear" ? [held.text] : [],
		};
		if (plan.lead.length) {
			this.toLead(answered ? null : handOff, plan.lead.join(" "));
			// The acknowledgement the voice's own was cancelled for: only now
			// that the words went, and never a promise. The hand-off gets a
			// note that its request is in progress (OpenAI's way for progress),
			// and "One sec." is a line of its own: sent as the hand-off's
			// commentary, which GPT-Live takes as a result, the voice went on to
			// invent one ("I've fixed the typo", "it'll go ahead in five seconds")
			// in 5 of 5 sessions; with the note, in 0 of 13, and the real result
			// was still spoken (probe, 2026-11-07).
			if (handOff && !answered) {
				this.send("session.thinking.append", handOff, IN_PROGRESS);
				this.send("session.commentary.append", null, "One sec.");
			}
		} else if (handOff && !answered) this.quiet(handOff);
	}

	/** A spoken yes to a card, or a decision's option picked by voice: said
	 *  back, then acted on after UNDO_MS, in case the user changes their mind. */
	private startApproval(open: Answerable, handOff: string | null, label?: string): void {
		this.stopApproval(false);
		this.topic = null;
		const act = () =>
			open.kind === "confirm"
				? this.lead().permission(open.id, "allow")
				: this.answerTask({
						taskId: open.taskId,
						questionId: open.questionId,
						answer: label ?? "",
					});
		const timer = setTimeout(() => {
			this.approval = null;
			this.update({ approving: null });
			act()
				.then(() => this.send("session.commentary.append", null, "Done."))
				.catch((e) =>
					this.send("session.commentary.append", null, `That didn't go through: ${words(e)}`),
				);
		}, UNDO_MS);
		this.approval = { open, timer };
		this.update({
			approving: { text: open.kind === "confirm" ? open.text : `${open.name}: ${label}` },
		});
		this.send(
			"session.commentary.append",
			handOff,
			open.kind === "confirm"
				? "Going ahead in five seconds. Say stop to cancel."
				: `Going with "${label}" in five seconds. Say stop to cancel.`,
		);
	}

	/** Stop a countdown; `say` tells the user, by voice, that it stopped. The
	 *  card is the topic again, so a no or a yes that follows still answers it. */
	private stopApproval(say: boolean, handOff: string | null = null): void {
		if (!this.approval) return;
		clearTimeout(this.approval.timer);
		if (say) this.topic = { ...this.approval.open, at: Date.now() };
		this.approval = null;
		this.update({ approving: null });
		if (say)
			this.send(
				"session.commentary.append",
				handOff,
				"Okay, stopped. It's still waiting in the chat.",
			);
	}

	/** A hand-off with no words left to judge: the quiet timer already sent
	 *  them, without a hand-off, a moment before it came. The Lead's reply then
	 *  answers this one. Otherwise it handed off nothing for the Lead. */
	private lateHandOff(handOff: string): void {
		const orphan = this.pending.lastIndexOf(null);
		if (orphan >= 0 && Date.now() - this.sentAt < LATE_HAND_OFF_MS) this.pending[orphan] = handOff;
		else this.quiet(handOff);
	}

	/** The voice handed off words that weren't for the Lead: it says nothing more. */
	private quiet(handOff: string): void {
		this.send(
			"session.thinking.append",
			handOff,
			"That was not said to you: the user was talking to someone else, or it was background noise. Say nothing about it.",
		);
	}

	private hold(held: NonNullable<CallView["held"]>): void {
		const now = Date.now();
		this.asides = [
			...this.asides.filter((a) => now - a.at < ASIDE_MEMORY_MS).slice(-4),
			{ ...held, at: now },
		];
		if (this.heldTimer) clearTimeout(this.heldTimer);
		this.heldTimer = setTimeout(() => this.update({ held: null }), HELD_MS);
		this.update({ held });
	}

	/** Words for the Lead: into the chat as the user's message. */
	private toLead(handOff: string | null, text: string): void {
		this.sentSinceWake = true;
		this.engagedAt = this.sentAt = Date.now();
		this.pending.push(handOff);
		this.lead()
			.send(text)
			.catch((e) => {
				const at = this.pending.indexOf(handOff);
				if (at >= 0) this.pending.splice(at, 1);
				this.send("session.commentary.append", handOff, `I didn't get that: ${words(e)}`);
			});
	}

	// ---- the chat ----------------------------------------------------------------

	private onLead(e: LeadEvent): void {
		if (e.type === "reset") {
			this.items = e.snapshot.items;
			for (const i of this.items) this.seen.add(i.id);
			return;
		}
		if (e.type === "busy") {
			if (!e.busy && this.pending.length) {
				const text = speakable([...this.reply.values()].join("\n\n"));
				const id = this.pending.at(-1) ?? null;
				this.pending = [];
				this.reply.clear();
				this.send("session.commentary.append", id, text || "Done, nothing to add.");
			}
			return;
		}
		if (e.type !== "item") return;
		const item = e.item;
		const at = this.items.findIndex((i) => i.id === item.id);
		if (at >= 0) this.items[at] = item;
		else this.items.push(item);
		// A card answered (a tap, another window, a restart): no longer the topic.
		if (item.kind === "permission" && item.answer) {
			if (this.topic?.kind === "confirm" && this.topic.id === item.id) this.topic = null;
			const counting = this.approval?.open;
			if (counting?.kind === "confirm" && counting.id === item.id) this.stopApproval(false);
		}
		if (item.kind === "assistant" && this.pending.length) {
			this.reply.set(item.id, item.text);
			this.seen.add(item.id);
			return;
		}
		if (this.seen.has(item.id)) return;
		this.seen.add(item.id);
		if (item.kind === "agent") {
			void this.nudge(item);
			return;
		}
		const line = announcement(item);
		if (!line) return;
		if (item.kind === "permission")
			this.topic = {
				kind: "confirm",
				id: item.id,
				text: speakable(item.text, 600),
				at: Date.now(),
			};
		this.say(line);
	}

	/** A task's reply, told as one short line: usually news, not a request.
	 *  What the user says about it next reaches the Lead tagged with the task,
	 *  unless a card or a decision is still open: a reply never takes their
	 *  place, or "go ahead" would stop picking the decision's button. */
	private async nudge(item: Extract<LeadItem, { kind: "agent" }>): Promise<void> {
		const line = await this.lead()
			.callNudge(item.task.name, item.text)
			.catch(() => announcement(item));
		if (this.state === "off" || !line) return;
		const open = activeTopic(Date.now(), this.topic, this.view.approving);
		if (!open || open.kind === "reply")
			this.topic = {
				kind: "reply",
				taskId: item.task.taskId,
				name: item.task.name,
				text: line,
				at: Date.now(),
			};
		this.say(line);
	}

	/** A line the call says on its own (not the Lead's reply, which is in the
	 *  chat): remembered for the gate, which judges what the user says next
	 *  against what they just heard. */
	private say(text: string): void {
		this.said = [...this.said.slice(-3), { text, at: Date.now() }];
		this.send("session.commentary.append", null, text);
	}

	// ---- hold and wake -------------------------------------------------------------

	private tick(): void {
		const now = Date.now();
		if (this.state !== "off" && now - this.beatAt >= CALL_BEAT_MS) {
			this.beatAt = now;
			void this.lead()
				.callActive(true)
				.catch(() => {});
		}
		if (this.view.voiceWakePaused && now >= this.voiceWakeOffUntil)
			this.update({ voiceWakePaused: false });
		if (this.state !== "live" || this.approval) return;
		const falseWake = this.wokeBySound && !this.sentSinceWake;
		if (
			shouldHold({
				now,
				engagedAt: this.engagedAt,
				heardAt: this.heardAt,
				falseWake,
				pending: this.pending.length > 0,
				waitingOnUser: waitingOnUser(this.items),
				unjudged: this.frags.length > 0,
			})
		)
			void this.toHold();
	}

	/** The mic's level, on this device: on hold, someone starting to talk wakes the call. */
	private listen(): void {
		if (!this.mic) return;
		this.vadTimer = setInterval(() => {
			const meter = this.meter;
			if (
				!meter ||
				this.state !== "hold" ||
				this.view.muted ||
				Date.now() < this.voiceWakeOffUntil
			) {
				this.loudSince = 0;
				return;
			}
			const now = Date.now();
			if (meter.level() <= SPEECH_RMS) {
				this.loudSince = 0;
				return;
			}
			this.loudSince ||= now;
			if (now - this.loudSince >= SPEECH_MS) {
				this.loudSince = 0;
				this.wokeBySound = true;
				this.wake();
			}
		}, 50);
	}
}

function iceGathered(pc: CallPeer): Promise<void> {
	if (pc.iceGatheringState === "complete") return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			if (pc.iceGatheringState !== "complete") return;
			pc.removeEventListener("icegatheringstatechange", done);
			resolve();
		};
		pc.addEventListener("icegatheringstatechange", done);
		setTimeout(resolve, 10_000);
	});
}

const words = (e: unknown): string =>
	(e instanceof Error ? e.message : String(e)).replace(
		/^Error invoking remote method '[^']+': (Error: )?/,
		"",
	);
