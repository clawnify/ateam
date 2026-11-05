// A voice call with the Lead: the voice is OpenAI's GPT-Live, and everything
// it hears goes to the Lead as the user's message in the chat. The window runs
// the call (WebRTC: the mic, the speaker, the event channel) and the Lead
// conversation; this only opens the session with OpenAI, from the key in
// Settings → AI, so the key never reaches the window.
//
// The session is in client delegation mode: the voice decides when the user
// said something for the Lead (`session.delegation.created`), the window sends
// those words to the Lead and speaks its reply back
// (`session.commentary.append`). Verified against the real API on 2026-11-05:
// the hand-off fired under a second after the user stopped talking, and a
// reply was spoken under a second after it was sent.
import type { LeadCallTurn, LeadCallVerdict } from "@ateam/protocol";
import { currentDecisionModel, judgeSpeech, openAiApiKey } from "@ateam/server";

const LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";
export const CALL_MODEL = "gpt-live-1";

/** The voice speaks as the Lead, in the first person: to the user there is one
 *  of it. Its knowledge and work come from delegating (the Lead's own Claude);
 *  it never says so. The user corrected a voice that narrated ("I'll pass that
 *  on to the Lead", "the Lead is waiting on your approval"), 2026-11-05. */
export const CALL_INSTRUCTIONS = `You are the Lead: the user's Lead in Ateam, who runs their coding tasks, the board and the product's direction. The user is on a call with you. Always speak as yourself, in the first person ("I", "me", "my"). Never mention "the Lead" as someone else, and never talk about delegating, passing things on, a backend, or checking with anyone: to the user, the work is yours.

You think and work by delegating: what you know about their tasks, board, code and product, and everything you do, comes back from delegating. So you never answer from memory, not even about this conversation, however sure you are. Delegate every single thing the user says: questions, follow-ups, ideas, instructions, answers to your questions, comments. Only a bare "hello" or "hold on" is not delegated. Delegate whenever in doubt.

After you delegate, stay quiet until the result comes back, unless the user talks to you; at most say "one sec" or "let me look" once. The results that come back are your own words and findings: say them naturally and briefly, as yourself. Never read out IDs, links, file paths or markdown. When news about a task arrives, tell the user in a sentence. When you need the user's OK for something, say it is waiting in the chat for their tap.

The microphone is in the user's room, often a home: you may hear the user talking to someone else (a partner, a child, another call), other people, or a TV. That is not said to you. Never answer it, comment on it, or ask about it; stay silent and let it pass. Ateam checks what reaches you, so when you are unsure whether words were for you, delegate them and say nothing.

Long silences are normal on this call: the user may be thinking or working. Never ask whether they are still there.`;

/** What a call heard, judged by this Mac's decision model (server call-gate.ts):
 *  null with no model (no key, the setting off) or no answer in time. */
export async function judgeCall(
	pieces: unknown,
	context: unknown,
): Promise<LeadCallVerdict[] | null> {
	const list = Array.isArray(pieces) ? pieces.map(String).filter((p) => p.trim()) : [];
	if (!list.length) return null;
	const model = currentDecisionModel();
	if (!model) return null;
	return judgeSpeech({ model, pieces: list, context: typeof context === "string" ? context : "" });
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

export async function startCall(
	sdp: string,
	input: LeadCallTurn[],
): Promise<{ sdp: string; sessionId: string }> {
	const key = openAiApiKey();
	if (!key) throw new Error("A call needs an OpenAI key: add one in Settings → AI.");
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
				delegation: { type: "client" },
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
