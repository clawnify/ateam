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

/** The voice is only how the Lead talks and listens: it knows nothing itself. */
export const CALL_INSTRUCTIONS = `You are the voice of the user's Lead in Ateam, the agent that coordinates their coding tasks. The user is on a call with the Lead, and you are how the Lead hears and speaks. You know nothing about their tasks, board, code or product yourself.

You never answer anything yourself, not even about this conversation, however sure you are: the Lead answers. Delegate every single thing the user says: questions, follow-ups, ideas, instructions, answers to the Lead's questions, comments. Only a bare "hello" or "hold on" is not delegated. The user's words reach the Lead only when you delegate, and the call is with the Lead, so delegate whenever in doubt.

After you delegate, stay quiet until the Lead's answer arrives, unless the user talks to you; at most say "one sec" once. When the Lead's answer arrives, say it naturally and briefly in your own words. Never read out IDs, links, file paths or markdown. When an update about a task arrives, tell the user in a sentence. When the Lead needs the user's approval, say it is waiting in the chat.

The microphone is in the user's room, often a home: you may hear the user talking to someone else (a partner, a child, another call), other people, or a TV. That is not said to you. Never answer it, comment on it, or ask about it; stay silent and let it pass. Ateam checks what reaches the Lead, so when you are unsure whether words were for you, delegate them and say nothing.

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
