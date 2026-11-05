// A voice call with the Lead (prototype). The call is with the Lead and lives
// in its chat: what the user says goes to the Lead as their message, and the
// Lead's reply is spoken. The voice is OpenAI's GPT-Live over WebRTC; main
// opens its session (main/lead/call.ts) so the key stays out of the window.
//
// The mic hears the whole room: the user talking to someone else, other
// people, a TV. Only words said to the Lead may reach it, since the Lead acts
// on what it is told. So every utterance the call hears, split at pauses, is
// judged by the decision model (main → server call-gate.ts, fast and cheap)
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
import type {
	AteamLead,
	LeadCallTurn,
	LeadCallVerdict,
	LeadEvent,
	LeadItem,
} from "@ateam/protocol";

export type CallState = "off" | "connecting" | "live" | "hold";

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
/** How often the window tells the Lead the call is still on (it lapses after
 *  90 s without, server lead/index.ts CALL_GUARD_MS). */
const CALL_BEAT_MS = 30_000;
/** This many false wakes within FALSE_WAKES_WINDOW_MS pause waking by sound. */
const FALSE_WAKES = 3;
const FALSE_WAKES_WINDOW_MS = 5 * 60_000;
const VOICE_WAKE_PAUSE_MS = 10 * 60_000;
/** A gap this long between transcript fragments splits two pieces of speech. */
export const PIECE_GAP_MS = 800;
/** No new words this long after some: the utterance is over, judge it. The
 *  voice's hand-off came 0-1.2 s after the last word in tests, and usually wins. */
const QUIET_JUDGE_MS = 1_500;
/** A hand-off this soon after words went to the Lead without one is for them. */
const LATE_HAND_OFF_MS = 3_000;
/** Not sent, shown in the bar this long. */
const HELD_MS = 30_000;
/** Mic level (RMS, 0..1) and duration that count as someone starting to talk on hold. */
const SPEECH_RMS = 0.03;
const SPEECH_MS = 250;
/** About 500 tokens, OpenAI's cap on one commentary append. */
const SPEAK_MAX = 1800;

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

/**
 * The last few turns, for the gate to judge what it heard against: the chat
 * with the Lead and what the call held back, in time order, each with its
 * age. Both matter, measured: a bare "okok" after the Lead asked "Should I go
 * ahead?" went to the Lead (Jev 0.83-0.87, Luna 0.97) even when it answered a
 * question the user had just asked someone else; told that "Did you give food
 * to the cat?" was said to someone 4 s ago and the Lead asked 25 s ago, both
 * held it (0.28-0.38), and still sent it when the Lead had just asked.
 */
export function contextFrom(
	items: LeadItem[],
	asides: HeardAside[] = [],
	now = Date.now(),
	turns = 6,
): string {
	const lines: { at: number; line: string }[] = [];
	for (const it of items) {
		if (it.kind === "user" && !it.to)
			lines.push({ at: it.at, line: `user (${ago(now - it.at)}): ${speakable(it.text, 300)}` });
		else if (it.kind === "assistant")
			lines.push({ at: it.at, line: `lead (${ago(now - it.at)}): ${speakable(it.text, 300)}` });
	}
	for (const a of asides) {
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
 *  person: the voice is the Lead (main/lead/call.ts CALL_INSTRUCTIONS). */
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

/** Fragments as pieces of speech, split where the gap between two is long. */
export function piecesOf(frags: Fragment[], gapMs = PIECE_GAP_MS): string[] {
	const pieces: string[] = [];
	let cur = "";
	let lastEnd = Number.NEGATIVE_INFINITY;
	for (const f of frags) {
		// Punctuation can arrive late, timed with the next words ("?" after a
		// question): it ends the piece before it, never starts one.
		if (/^[\p{P}\s]*$/u.test(f.text)) {
			if (cur) cur += f.text;
			else if (pieces.length) pieces[pieces.length - 1] += f.text;
			continue;
		}
		if (cur && f.start - lastEnd >= gapMs) {
			pieces.push(cur);
			cur = "";
		}
		cur += f.text;
		lastEnd = f.end;
	}
	if (cur) pieces.push(cur);
	return pieces.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
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
}): boolean {
	const idle = s.now - s.engagedAt;
	const quiet = s.now - s.heardAt;
	// Waiting on the Lead is no reason to bill silence forever: not while it
	// waits on the user, nor through a long turn. Its reply reopens the call.
	if (s.pending)
		return quiet > 3_000 && (s.waitingOnUser ? idle > WAITING_HOLD_MS : idle > PENDING_HOLD_MS);
	if (s.falseWake && idle > FALSE_WAKE_MS && quiet > 1_500) return true;
	if (idle > HOLD_AFTER_MS && quiet > 3_000) return true;
	return idle > CHATTER_CAP_MS;
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

export interface CallView {
	state: CallState;
	/** Words for the user when the last attempt failed. */
	error: string;
	muted: boolean;
	/** Heard but not sent to the Lead: shown with Send, never kept. */
	held: { text: string; kind: LeadCallVerdict["kind"] } | null;
	/** Too many false wakes: speech won't pick up the call for a while. */
	voiceWakePaused: boolean;
}

export class LeadCall {
	view: CallView = { state: "off", error: "", muted: false, held: null, voiceWakePaused: false };
	private listeners = new Set<() => void>();
	private mic: MediaStream | null = null;
	private pc: RTCPeerConnection | null = null;
	private dc: RTCDataChannel | null = null;
	private audio: HTMLAudioElement | null = null;
	private started: (() => void) | null = null;
	private closed: (() => void) | null = null;
	private ctx: AudioContext | null = null;
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

	constructor(private readonly lead: () => AteamLead) {}

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

	/** From a click: the mic asks for permission now. */
	async start(): Promise<void> {
		if (this.state !== "off") return;
		this.update({ state: "connecting", error: "", held: null, muted: false });
		try {
			// First: a chat that can't hold its Lead's messages for a tap (a box
			// too old) gets no call at all.
			await this.lead().callActive(true);
			this.beatAt = Date.now();
			const snap = await this.lead().snapshot();
			this.items = snap.items;
			this.seen = new Set(snap.items.map((i) => i.id));
			// Warm the decision model: its first call of a session is the slow one.
			void this.lead()
				.callJudge(["Hello."], "")
				.catch(() => null);
			this.mic = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
			this.unsub = this.lead().onEvent((e) => this.onLead(e));
			this.listen();
			this.tickTimer = setInterval(() => this.tick(), 1000);
			this.wokeBySound = false;
			await this.open();
		} catch (e) {
			this.hangUp(words(e));
		}
	}

	/** End the call: the voice session, the mic, the listening. */
	hangUp(error = ""): void {
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
		void this.ctx?.close();
		this.ctx = null;
		this.pending = [];
		this.reply.clear();
		this.queued = [];
		this.frags = [];
		this.asides = [];
		this.update({ state: "off", error, held: null, muted: false });
	}

	/** Nothing from the mic leaves this Mac while muted. */
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
		const pc = new RTCPeerConnection();
		this.pc = pc;
		this.audio ??= Object.assign(new Audio(), { autoplay: true });
		pc.ontrack = (e) => {
			if (this.audio) this.audio.srcObject = new MediaStream([e.track]);
		};
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
		await this.closeSession();
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
		if (this.state !== "hold") return;
		chime(this.ctx);
		this.open().catch((e) => {
			// Couldn't reopen: stay on hold and say why.
			void this.closeSession();
			this.update({ state: "hold", error: words(e) });
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
				this.frags.push({
					text: String(ev.delta ?? ""),
					start: Number(ev.start_ms ?? 0),
					end: Number(ev.end_ms ?? 0),
				});
				this.heardAt = Date.now();
				this.judgeSoon(QUIET_JUDGE_MS);
				break;
			case "session.output_transcript.delta":
				this.engagedAt = Date.now();
				// The voice answering means the user's turn is over.
				if (this.frags.length) this.judgeSoon(300);
				break;
			case "session.delegation.created": {
				const id = String((ev.delegation as { id?: string } | undefined)?.id ?? "");
				// The last words' transcript can land just after the hand-off.
				this.judgeSoon(400, id);
				break;
			}
			case "session.closed":
				this.closed?.();
				// OpenAI ended it (its time limit, a dropped line): on hold, not off.
				if (this.state === "live") {
					void this.closeSession();
					this.update({ state: "hold" });
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

	/** The gate: only words the decision model puts as said to the Lead go to it. */
	private async judge(handOff: string | null): Promise<void> {
		const pieces = piecesOf(this.frags);
		this.frags = [];
		if (!pieces.length) {
			if (handOff) this.lateHandOff(handOff);
			return;
		}
		const verdicts = await this.lead()
			.callJudge(pieces, contextFrom(this.items, this.asides))
			.catch(() => null);
		// No decision model (no key, turned off) or no answer in time: trust the
		// voice's hand-off, and hold back what it didn't hand off.
		const sent: string[] = [];
		let held: CallView["held"] = null;
		for (const [i, text] of pieces.entries()) {
			const v = verdicts?.[i];
			if (v ? v.send : !!handOff) sent.push(text);
			else held = { text, kind: v?.kind ?? "unclear" };
		}
		if (held) this.hold(held);
		if (sent.length) this.toLead(handOff, sent.join(" "));
		else if (handOff) this.quiet(handOff);
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
		const say = announcement(item);
		if (say) this.send("session.commentary.append", null, say);
	}

	/** A task's reply, told as one short line: usually news, not a request. */
	private async nudge(item: Extract<LeadItem, { kind: "agent" }>): Promise<void> {
		const line = await this.lead()
			.callNudge(item.task.name, item.text)
			.catch(() => announcement(item));
		if (this.state === "off" || !line) return;
		this.send("session.commentary.append", null, line);
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
		if (this.state !== "live") return;
		const falseWake = this.wokeBySound && !this.sentSinceWake;
		if (
			shouldHold({
				now,
				engagedAt: this.engagedAt,
				heardAt: this.heardAt,
				falseWake,
				pending: this.pending.length > 0,
				waitingOnUser: waitingOnUser(this.items),
			})
		)
			void this.toHold();
	}

	/** The mic's level, here in the window: on hold, someone starting to talk wakes the call. */
	private listen(): void {
		if (!this.mic) return;
		this.ctx = new AudioContext();
		const analyser = this.ctx.createAnalyser();
		analyser.fftSize = 1024;
		this.ctx.createMediaStreamSource(this.mic).connect(analyser);
		const buf = new Float32Array(analyser.fftSize);
		this.vadTimer = setInterval(() => {
			if (this.state !== "hold" || this.view.muted || Date.now() < this.voiceWakeOffUntil) {
				this.loudSince = 0;
				return;
			}
			analyser.getFloatTimeDomainData(buf);
			let sum = 0;
			for (const v of buf) sum += v * v;
			const now = Date.now();
			if (Math.sqrt(sum / buf.length) <= SPEECH_RMS) {
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

function iceGathered(pc: RTCPeerConnection): Promise<void> {
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

/** Two short notes: the call hears you again. */
function chime(ctx: AudioContext | null): void {
	if (!ctx) return;
	const t = ctx.currentTime;
	for (const [i, f] of [660, 880].entries()) {
		const o = ctx.createOscillator();
		const g = ctx.createGain();
		o.frequency.value = f;
		g.gain.setValueAtTime(0.0001, t + i * 0.12);
		g.gain.exponentialRampToValueAtTime(0.15, t + i * 0.12 + 0.02);
		g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.11);
		o.connect(g).connect(ctx.destination);
		o.start(t + i * 0.12);
		o.stop(t + i * 0.12 + 0.12);
	}
}

const words = (e: unknown): string =>
	(e instanceof Error ? e.message : String(e)).replace(
		/^Error invoking remote method '[^']+': (Error: )?/,
		"",
	);

/** One call per window, so it survives the chat moving between its tab and the sidebar. */
export const leadCall = new LeadCall(() => window.ateamLead);
