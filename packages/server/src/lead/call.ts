// A voice call with the Lead: the voice is OpenAI's GPT-Live, and everything
// it hears goes to the Lead as the user's message in the chat. The client runs
// the call (WebRTC: the mic, the speaker, the event channel; the shared engine
// in @ateam/protocol lead-call) and the Lead conversation; this opens the
// session with OpenAI, judges what the call heard and words a task's reply, on
// the machine whose Lead it is: the Mac for its own Lead (desktop main), a box
// for its Lead (engine-lead.ts, which Ateam Go calls). The OpenAI key, from
// Settings → AI (pushed to boxes), never reaches a client.
//
// The session is in client delegation mode: the voice decides when the user
// said something for the Lead (`session.delegation.created`), the window sends
// those words to the Lead and speaks its reply back
// (`session.commentary.append`). Verified against the real API on 2026-11-05:
// the hand-off fired under a second after the user stopped talking, and a
// reply was spoken under a second after it was sent.
import type { LeadCallTopic, LeadCallTurn, LeadCallVerdict } from "@ateam/protocol";
import { judgeSpeech } from "../call-gate";
import { openAiApiKey } from "../credentials-file";
import { currentDecisionModel } from "../decision-model";
import { classifyTurn } from "../jev";
import { askConfiguredTextModel } from "../text-model";

const LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";
export const CALL_MODEL = "gpt-live-1";

/** When GPT-Live requests its own acknowledgement of a hand-off, which the
 *  client always cancels first (lead-call's LeadCall): it acknowledges itself
 *  once the gate has sent the words. 800 is the most OpenAI accepts
 *  ("Expected a value <= 800": 1000 failed every call, 2026-11-05; the guide
 *  gives no limit). */
const ACK_DELAY_MS = 800;

/** The voice speaks as the Lead, in the first person: to the user there is one
 *  of it. Its knowledge and work come from delegating (the Lead's own Claude);
 *  it never says so. The user corrected a voice that narrated ("I'll pass that
 *  on to the Lead", "the Lead is waiting on your approval"), 2026-11-05. */
export const CALL_INSTRUCTIONS = `You are the Lead: the user's Lead in Ateam, who runs their coding tasks, the board and the product's direction. The user is on a call with you. Always speak as yourself, in the first person ("I", "me", "my"). Never mention "the Lead" as someone else, and never talk about delegating, passing things on, a backend, or checking with anyone: to the user, the work is yours.

You think and work by delegating: what you know about their tasks, board, code and product, and everything you do, comes back from delegating. So you never answer from memory, not even about this conversation, however sure you are. Delegate every single thing the user says: questions, follow-ups, ideas, instructions, answers to your questions, comments. Only a bare "hello" or "hold on" is not delegated. Delegate whenever in doubt.

After you delegate, stay quiet until the result comes back, unless the user talks to you; at most say "one sec" or "let me look" once. Never promise to do it ("I'll take care of that", "on it", "will do"): Ateam first checks the words were said to you, and may hold them back. The results that come back are your own words and findings: say them naturally and briefly, as yourself. Never read out IDs, links, file paths or markdown. When news about a task arrives, tell the user in a sentence. When you need the user's OK for something, say it is waiting in the chat for their tap.

When the user answers one (yes, no, stop, or anything else), say nothing until the result comes back: Ateam decides what their answer means. Never say that anything is sent, done, approved or going ahead unless a result you received says so. When a result says something goes ahead in five seconds, say that, and that they can say stop to cancel.

The microphone is in the user's room, often a home: you may hear the user talking to someone else (a partner, a child, another call), other people, or a TV. That is not said to you. Never answer it, comment on it, or ask about it; stay silent and let it pass. Ateam checks what reaches you, so when you are unsure whether words were for you, delegate them and say nothing.

Long silences are normal on this call: the user may be thinking or working. Never ask whether they are still there.`;

/** What a call heard, judged by this machine's decision model (call-gate.ts):
 *  null with no model (no key, the setting off) or no answer in time. */
export async function judgeCall(
	pieces: unknown,
	context: unknown,
	opts?: unknown,
): Promise<LeadCallVerdict[] | null> {
	const list = Array.isArray(pieces) ? pieces.map(String).filter((p) => p.trim()) : [];
	if (!list.length) return null;
	const model = currentDecisionModel();
	if (!model) return null;
	const o = (opts ?? {}) as { topic?: unknown; continuing?: unknown; handedOff?: unknown };
	const continuing = o.continuing;
	const t = o.topic as { kind?: unknown; text?: unknown; options?: unknown } | undefined;
	const kind =
		t?.kind === "confirm" || t?.kind === "decision" || t?.kind === "reply" ? t.kind : null;
	const text = typeof t?.text === "string" ? t.text.trim() : "";
	const options = Array.isArray(t?.options)
		? t.options.flatMap((o) => {
				const x = o as { label?: unknown; recommended?: unknown; description?: unknown };
				return typeof x?.label === "string" && x.label.trim()
					? [
							{
								label: x.label.slice(0, 200),
								...(x.recommended === true ? { recommended: true } : {}),
								...(typeof x.description === "string"
									? { description: x.description.slice(0, 300) }
									: {}),
							},
						]
					: [];
			})
		: [];
	const open: LeadCallTopic | undefined =
		kind && text ? { kind, text, ...(options.length ? { options } : {}) } : undefined;
	return judgeSpeech({
		model,
		pieces: list,
		context: typeof context === "string" ? context : "",
		...(open ? { topic: open } : {}),
		...(typeof continuing === "string" && continuing.trim()
			? { continuing: continuing.trim() }
			: {}),
		handedOff: o.handedOff === true,
	});
}

/** OpenAI's limits on a session's starting history. */
const MAX_TURNS = 128;
const MAX_CHARS = 24_000; // about 8,192 tokens

/** The newest turns that fit, oldest first, each one text part. */
export function seedInput(turns: LeadCallTurn[]): unknown[] {
	const kept: LeadCallTurn[] = [];
	let chars = 0;
	for (let i = turns.length - 1; i >= 0 && kept.length < MAX_TURNS; i--) {
		const t = turns[i];
		const text = String(t?.text ?? "").trim();
		if (!t || !text || !["user", "assistant", "developer"].includes(t.role)) continue;
		if (chars + text.length > MAX_CHARS) break;
		chars += text.length;
		kept.unshift({ role: t.role, text });
	}
	return kept.map((t) => ({
		role: t.role,
		content: [{ type: t.role === "assistant" ? "output_text" : "input_text", text: t.text }],
	}));
}

/** `noKey`: what to tell the user when this machine has no OpenAI key, in
 *  words for where they are (a box sends them to their Mac). */
export async function startCall(
	sdp: string,
	input: LeadCallTurn[],
	noKey = "A call needs an OpenAI key: add one in Settings → AI.",
): Promise<{ sdp: string; sessionId: string }> {
	const key = openAiApiKey();
	if (!key) throw new Error(noKey);
	if (typeof sdp !== "string" || !sdp.startsWith("v="))
		throw new Error("The call's connection offer was empty.");
	const seed = seedInput(Array.isArray(input) ? input : []);
	const res = await fetch(LIVE_SESSIONS_URL, {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			session: {
				model: CALL_MODEL,
				instructions: CALL_INSTRUCTIONS,
				// The voice's automatic acknowledgement of a hand-off is requested
				// after this delay, so the client's cancel (an empty thinking
				// append, sent the moment the hand-off arrives) always lands first:
				// left unset, it spoke 0.2 s after the hand-off, before any cancel,
				// and before the gate ruled ("Sure. Checking that." for words then
				// held, live 2026-11-05). OpenAI's live-delegation guide.
				delegation: { type: "client", acknowledgement_delay_ms: ACK_DELAY_MS },
				...(seed.length ? { input: seed } : {}),
			},
			transport: { type: "webrtc", sdp },
		}),
		signal: AbortSignal.timeout(20_000),
	});
	const body = (await res.json().catch(() => null)) as {
		session?: { id?: string };
		transport?: { sdp?: string };
		error?: { message?: string };
	} | null;
	if (!res.ok || !body?.transport?.sdp) {
		const why = body?.error?.message ?? `HTTP ${res.status}`;
		throw new Error(`OpenAI didn't start the call: ${why}`);
	}
	return { sdp: body.transport.sdp, sessionId: body.session?.id ?? "" };
}

/** A task's reply, told on a call: one short spoken line, not the reply. A
 *  reply is usually news, not a request (the user, 2026-11-05: "they do not
 *  necessarily mean they need us"), so the line says the user is needed only
 *  when the board's own turn classifier says so (jev.ts classifyTurn, the
 *  call that moves a card to Needs you). The text model writes only the
 *  headline: asked for both in one line, it kept adding "nothing needs your
 *  input" to news and dropped "It needs you" from a reply waiting on a choice
 *  (2026-11-05, 9 runs). The whole reply stays in the chat. */
export function nudgePrompt(task: string, reply: string): string {
	return `A coding agent working on the task "${task}" just finished a turn and wrote the reply below. Write a spoken news headline about it: at most 14 words saying what the agent did or found. No pronouns (no "I", "you", "we"), no verdict on whether anyone needs to act, no markdown, IDs, links, file paths, phone numbers or other personal data. Reply with the headline only.

The agent's reply:
${reply.slice(0, 4000)}`;
}

/** The model's headline as one clean spoken phrase, or "". */
export function headlineOf(raw: string | null): string {
	const line = (raw ?? "").trim().split("\n")[0] ?? "";
	return line
		.replace(/[*_#`>]/g, "")
		.replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, "")
		.replace(/[.!\s]+$/, "")
		.trim();
}

/** What the board's classifier saw, as the words the call adds. */
export function needWords(v: { step: string; legs: Record<string, number> } | null): string {
	if (v?.step !== "needs_attention") return "";
	if ((v.legs.asks_user ?? 0) >= 0.5) return "It's waiting on your answer.";
	if ((v.legs.blocked ?? 0) >= 0.5) return "It says it's blocked.";
	return "It stopped before finishing.";
}

/** The spoken line for a task's reply; plain words when no model answers in time. */
export async function nudgeFor(task: unknown, reply: unknown): Promise<string> {
	const name = String(task ?? "").slice(0, 120) || "a task";
	const text = String(reply ?? "").trim();
	if (!text) return `The task "${name}" replied. It's in the chat.`;
	const model = currentDecisionModel();
	const [raw, verdict] = await Promise.all([
		askConfiguredTextModel(nudgePrompt(name, text), { maxTokens: 60, timeoutMs: 8_000 }).catch(
			() => null,
		),
		model ? classifyTurn({ model, finalMessage: text }).catch(() => null) : null,
	]);
	const headline = headlineOf(raw);
	const need = needWords(verdict);
	const said = headline
		? `The task "${name}": ${headline}.`
		: `The task "${name}" replied, it's in the chat.`;
	return need ? `${said} ${need}` : said;
}
