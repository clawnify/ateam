// A voice call with the Lead (prototype). The call is with the Lead and lives
// in its chat: what the user says goes to the Lead as their message, and the
// Lead's reply is spoken. The voice is OpenAI's GPT-Live over WebRTC; main
// opens its session (main/lead/call.ts) so the key stays out of the window.
//
// A call is a state, not a connection. GPT-Live bills every second a session
// is open, silence included, so after HOLD_AFTER_MS with nobody talking and
// nothing pending the voice session closes and the call goes on hold: the mic
// stays on here, and speech, or something worth telling (a task replied, the
// Lead needs an approval), opens a new session seeded with the chat so far.
// OpenAI's own guidance for agents that work a long time is the same: close
// the voice during long work, reopen on a completion event (its "Voice latency
// and cost" guide).
//
// Known gap: words spoken while on hold, before the new session is up (about
// 1.5 s), are not heard. The chime says when it is listening again.
import type { AteamLead, LeadCallTurn, LeadEvent, LeadItem } from "@ateam/protocol";

export type CallState = "off" | "connecting" | "live" | "hold";

/** Quiet this long with nothing pending: close the voice session, stay on the call. */
export const HOLD_AFTER_MS = 30_000;
/** Mic level (RMS, 0..1) and duration that count as the user starting to talk on hold. */
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

/** What to tell the user about something new in the chat they didn't ask for
 *  on this call, or null when it isn't worth interrupting for. */
export function announcement(item: LeadItem): string | null {
	switch (item.kind) {
		case "agent":
			return `Update: the task "${item.task.name}" replied: ${speakable(item.text, 900)}`;
		case "page":
			return `Update: the task "${item.task.name}" put a page in the chat, "${item.title}".`;
		case "permission":
			return item.answer
				? null
				: `The Lead needs your approval in the chat: ${speakable(item.text, 300)}`;
		case "proposal":
			return item.outcome
				? null
				: `The Lead proposes a ${item.proposal.kind}, "${item.proposal.name}". It's waiting in the chat for you to create it.`;
		case "notice":
			return item.tone === "error" ? `The Lead says: ${item.text}` : null;
		default:
			return null;
	}
}

export class LeadCall {
	state: CallState = "off";
	/** Words for the user when the last attempt failed. */
	error = "";
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
	private unsub: (() => void) | null = null;
	private items: LeadItem[] = [];
	private seen = new Set<string>();
	/** What the user has said since the last delegation. */
	private heard = "";
	/** Delegations waiting on the Lead's turn, oldest first; null for words the
	 *  voice answered by itself, sent on to the Lead all the same. */
	private pending: (string | null)[] = [];
	/** A delegation came and its words are about to be sent. */
	private delegating = false;
	/** The voice began answering words it never delegated: they go to the Lead anyway. */
	private unrelayed: ReturnType<typeof setTimeout> | null = null;
	/** The Lead's text in the turn answering them, by item id. */
	private reply = new Map<string, string>();
	/** Said while no session was open: told once one is. */
	private queued: string[] = [];
	private lastActivity = 0;
	private loudSince = 0;
	private n = 0;

	constructor(private readonly lead: () => AteamLead) {}

	subscribe(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}
	private set(state: CallState, error = this.error): void {
		this.state = state;
		this.error = error;
		for (const cb of this.listeners) cb();
	}

	/** From a click: the mic asks for permission now. */
	async start(): Promise<void> {
		if (this.state !== "off") return;
		this.set("connecting", "");
		try {
			const snap = await this.lead().snapshot();
			this.items = snap.items;
			this.seen = new Set(snap.items.map((i) => i.id));
			this.mic = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
			this.unsub = this.lead().onEvent((e) => this.onLead(e));
			this.listen();
			this.tickTimer = setInterval(() => this.tick(), 1000);
			await this.open();
		} catch (e) {
			this.hangUp(words(e));
		}
	}

	/** End the call: the voice session, the mic, the listening. */
	hangUp(error = ""): void {
		void this.closeSession();
		for (const t of this.mic?.getTracks() ?? []) t.stop();
		this.mic = null;
		this.unsub?.();
		this.unsub = null;
		if (this.vadTimer) clearInterval(this.vadTimer);
		if (this.tickTimer) clearInterval(this.tickTimer);
		this.vadTimer = this.tickTimer = null;
		void this.ctx?.close();
		this.ctx = null;
		this.pending = [];
		this.reply.clear();
		this.queued = [];
		this.heard = "";
		if (this.unrelayed) clearTimeout(this.unrelayed);
		this.unrelayed = null;
		this.delegating = false;
		this.set("off", error);
	}

	// ---- the voice session ------------------------------------------------------

	private async open(): Promise<void> {
		if (!this.mic) return;
		this.set("connecting");
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
		this.lastActivity = Date.now();
		this.set("live", "");
		for (const text of this.queued.splice(0)) this.send("session.commentary.append", null, text);
	}

	/** Close the session only (the call stays on): ask OpenAI to close, wait for it. */
	private async closeSession(): Promise<void> {
		const pc = this.pc;
		const dc = this.dc;
		this.pc = this.dc = null;
		this.started = null;
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
		this.set("hold");
		await this.closeSession();
	}

	/** Reopen from hold, with a chime so the user knows it hears them again. */
	private wake(): void {
		if (this.state !== "hold") return;
		chime(this.ctx);
		this.open().catch((e) => {
			// Couldn't reopen: stay on hold and say why.
			void this.closeSession();
			this.set("hold", words(e));
		});
	}

	private send(type: string, delegationId: string | null, content: string): void {
		if (this.dc?.readyState !== "open") {
			this.queued.push(content);
			this.wake();
			return;
		}
		this.dc.send(
			JSON.stringify({ type, event_id: this.id("c"), delegation_id: delegationId, content }),
		);
		this.lastActivity = Date.now();
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
				this.heard += String(ev.delta ?? "");
				this.lastActivity = Date.now();
				break;
			case "session.output_transcript.delta":
				this.lastActivity = Date.now();
				// The call is with the Lead: words the voice answers by itself still
				// go into the chat, unless a delegation for them follows.
				if (this.heard.trim() && !this.delegating && !this.unrelayed)
					this.unrelayed = setTimeout(() => {
						this.unrelayed = null;
						if (!this.delegating && this.heard.trim()) this.delegate(null);
					}, 700);
				break;
			case "session.delegation.created": {
				const id = String((ev.delegation as { id?: string } | undefined)?.id ?? "");
				this.delegating = true;
				if (this.unrelayed) clearTimeout(this.unrelayed);
				this.unrelayed = null;
				// The last words' transcript can land just after the delegation.
				setTimeout(() => {
					this.delegating = false;
					this.delegate(id);
				}, 400);
				break;
			}
			case "session.closed":
				this.closed?.();
				// OpenAI ended it (its time limit, a dropped line): on hold, not off.
				if (this.state === "live") {
					void this.closeSession();
					this.set("hold");
				}
				break;
			case "error":
				console.warn("[lead-call]", ev);
				break;
		}
	}

	/** The user said something for the Lead: it goes into the chat as their message. */
	private delegate(id: string | null): void {
		const text = this.heard.replace(/\s+/g, " ").trim();
		this.heard = "";
		if (!text) {
			if (id) this.send("session.commentary.append", id, "Sorry, I didn't catch that.");
			return;
		}
		this.pending.push(id);
		this.lead()
			.send(text)
			.catch((e) => {
				const at = this.pending.indexOf(id);
				if (at >= 0) this.pending.splice(at, 1);
				this.send("session.commentary.append", id, `The Lead didn't get that: ${words(e)}`);
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
				this.send(
					"session.commentary.append",
					id,
					text || "The Lead is done, with nothing to add.",
				);
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
		const say = announcement(item);
		if (say) this.send("session.commentary.append", null, say);
	}

	// ---- hold and wake -------------------------------------------------------------

	private tick(): void {
		if (this.state !== "live" || this.pending.length) return;
		if (Date.now() - this.lastActivity > HOLD_AFTER_MS) void this.toHold();
	}

	/** The mic's level, here in the window: on hold, the user starting to talk wakes the call. */
	private listen(): void {
		if (!this.mic) return;
		this.ctx = new AudioContext();
		const analyser = this.ctx.createAnalyser();
		analyser.fftSize = 1024;
		this.ctx.createMediaStreamSource(this.mic).connect(analyser);
		const buf = new Float32Array(analyser.fftSize);
		this.vadTimer = setInterval(() => {
			analyser.getFloatTimeDomainData(buf);
			let sum = 0;
			for (const v of buf) sum += v * v;
			const loud = Math.sqrt(sum / buf.length) > SPEECH_RMS;
			const now = Date.now();
			if (!loud) {
				this.loudSince = 0;
				return;
			}
			this.loudSince ||= now;
			if (this.state === "live") this.lastActivity = now;
			else if (this.state === "hold" && now - this.loudSince >= SPEECH_MS) {
				this.loudSince = 0;
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
