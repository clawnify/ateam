// Live calibration for the voice call's gate (packages/server/src/call-gate.ts):
// what the call heard, split at pauses as lead-call.ts splits it, through the
// shipped judgeSpeech, printed with each piece's probabilities so the questions
// and SEND_PROBABILITY can be judged against real answers.
//
// Makes live calls (a fraction of a cent in all). Run by hand:
//   cd apps/desktop && bun scripts/call-gate-calibrate.ts                    (Jev, OpenRouter)
//   cd apps/desktop && bun scripts/call-gate-calibrate.ts --provider openai  (Luna, OpenAI)
// Key: OPENROUTER_API_KEY, else ~/.ateam/credentials.json; OpenAI's from the file only.
import {
	CALL_GATE_MODEL,
	judgeSpeech,
	SEND_PROBABILITY,
	type SpeechTopic,
} from "../../../packages/server/src/call-gate";
import { openAiApiKey, openRouterApiKey } from "../../../packages/server/src/credentials-file";
import type { DecisionProvider } from "../../../packages/server/src/decision-model";
import { type Judged, rideAlong, type Utterance, withCarry } from "../src/renderer/src/lead-call";

const PRODUCT = `user: What's in flight on the board?
lead: Two tasks are running: the onboarding checklist and faster session search. The checklist agent asked which tone to use.`;
const NONE = "";
/** The Lead asked a yes/no 25 s ago; contexts carry ages as lead-call.ts's contextFrom writes them. */
const ASKED = `user (34 s ago): Tell the checklist agent to use a friendly tone.
lead (25 s ago): I can message the checklist task now and tell it to switch to a friendly tone. Should I go ahead?`;
const JUST_ASKED = `user (12 s ago): Tell the checklist agent to use a friendly tone.
lead (3 s ago): I can message the checklist task now and tell it to switch to a friendly tone. Should I go ahead?`;
const CAT = `heard, not sent to the Lead (4 s ago), said to someone else in the room: "Did you give food to the cat?"`;
/** A long Lead message whose question is its last line (whole: lead-call.ts gist keeps 700). */
const THREE_ASKS = `user (40 s ago): Yeah, I clicked allow
lead (36 s ago): Thanks, it went through. The billing copy agent wasn't running, so Ateam started it with your question. Ask me later and I'll tell you what it says. Next is Provider onboarding. It's waiting on three answers: should it create a paid test box for the pairing checks, should it keep the old test box, and can it stop the simulator and Metro?`;
const MUM = `heard, not sent to the Lead (1 s ago), said to someone else in the room: "Mom, hold on a second"`;
/** A task's reply, and the voice's own line about it. */
const SEARCH_REPLY = `lead (3 min ago): It's one line naming the company behind the product: its legal name and address. The agent wants it in the site footer, the terms and the privacy policy. Do you want me to tell the agent to go ahead, or to show you the exact wording first?
the task "Web search region" replied (50 s ago): Pinned orgs will now search the web through the provider's global host, the same way unpinned orgs already do. That's merged and waiting for the deploy. The data-region settings page now says web search is the exception: no search service runs in the EU yet, so search queries are processed globally. Please check this before the data processing agreement goes to the customer.
lead, said on the call (45 s ago): The web search task says pinned orgs now search globally, since no search service runs in the EU yet.`;
/** A long reply whose detail is in its middle; the voice's line named it. */
const NETWORK_REPLY = `lead (2 min ago): It's sent. The error report agent wasn't running, so Ateam started it with your question about the browser. Ask me later and I'll tell you what it found.
the task "Agent error report" replied (8 s ago): No, the agent isn't using the extension's tools. It does browse in the Chrome the extension is installed in. I only read from the box and changed nothing. … Nothing functional is lost: the agent got the same logged-in pages in the same Chrome. If you want agents to choose the extension here, the fix is one sentence in the tools file. That goes to every agent through the instructions update, so I haven't made it. Say if you want it.
lead, said on the call (5 s ago): The error report task says the agent skips the extension, partly because the box's network hits captchas.`;

/** Each piece of speech, and whether it should reach the Lead. */
/** `continuing`: the user's words to the Lead just before, in the same
 *  utterance (lead-call.ts passes them after a short pause); `handedOff`: the
 *  voice handed the words off as said to it. */
const CASES: {
	context: string;
	pieces: [string, boolean][];
	continuing?: string;
	handedOff?: boolean;
}[] = [
	{ context: NONE, pieces: [["Hey, what's in flight on the board right now?", true]] },
	{ context: PRODUCT, pieces: [["Tell the checklist one to use a friendly tone.", true]] },
	{
		context: PRODUCT,
		pieces: [["Hmm. I wonder if we should drop the free tier altogether.", true]],
	},
	{ context: PRODUCT, pieces: [["Yeah, go with that.", true]] },
	{ context: PRODUCT, pieces: [["Babe, did you feed the cat?", false]] },
	{ context: PRODUCT, pieces: [["Can you grab the milk on your way back?", false]] },
	{
		context: PRODUCT,
		pieces: [
			["Do you want pasta or pizza tonight?", false],
			["Okay, and start a task to show disk usage on the box page.", true],
		],
	},
	{
		context: PRODUCT,
		pieces: [["Hi Mark, sorry, can you hear me? I'm on the other call.", false]],
	},
	{
		context: PRODUCT,
		pieces: [["Officials say the storm will reach the coast by Thursday evening.", false]],
	},
	{
		context: PRODUCT,
		pieces: [["And now, back to the studio, with the latest on the markets.", false]],
	},
	{ context: PRODUCT, pieces: [["Um.", false]] },
	{ context: NONE, pieces: [["Mommy, can I have juice?", false]] },
	{ context: PRODUCT, pieces: [["What did I ask you a minute ago?", true]] },
	{ context: PRODUCT, pieces: [["Hold on, one second, I'll be right back.", false]] },
	{ context: PRODUCT, pieces: [["Merge the session search one when the tests pass.", true]] },
	// A bare yes: to the Lead's question, or to the person just asked something
	// (whose answer the mic didn't hear)? The asked-away-from-the-Lead case is
	// why held asides and ages are in the context.
	{ context: `${ASKED}\n${CAT}`, pieces: [["okok", false]] },
	{ context: JUST_ASKED, pieces: [["okok", true]] },
	{ context: ASKED, pieces: [["okok", true]] },
	{
		context: PRODUCT,
		pieces: [
			["No, not now, I'm working.", false],
			["Sorry. Where were we? The onboarding copy.", true],
		],
	},
	// Live misses, 2026-11-05, in neutral words. The user answered what they had
	// just heard, which the context then lacked: the end of a long Lead message
	// (its question), a task's reply, the voice's own one-line summary of it.
	{
		context: THREE_ASKS,
		pieces: [
			["You can delete the box", true],
			["and it can also stop the simulator", true],
		],
	},
	{
		context: SEARCH_REPLY,
		pieces: [
			["Yeah, let's just go global and then maybe in the future once we have the EU", true],
			[", legally we have to do that uh search in the EU", true],
		],
	},
	{
		context: `${SEARCH_REPLY}\nuser (2 s ago): Yeah, let's just go global and then maybe in the future once we have the EU`,
		pieces: [[", legally we have to do that uh search in the EU", true]],
		continuing: "Yeah, let's just go global and then maybe in the future once we have the EU",
	},
	{
		context: `${THREE_ASKS}\nuser (1 s ago): You can delete the box`,
		pieces: [["so it can also stop Metro", true]],
		continuing: "You can delete the box",
	},
	// Right after a request, in the same breath: side talk still stays back.
	{
		context: `${THREE_ASKS}\nuser (1 s ago): Delete the old test box.`,
		pieces: [["Yeah, just put it next to the door.", false]],
		continuing: "Delete the old test box.",
	},
	{
		context: `${THREE_ASKS}\nuser (1 s ago): Delete the old test box.`,
		pieces: [["Mum, can I call you back in five minutes?", false]],
		continuing: "Delete the old test box.",
	},
	{
		context: `${PRODUCT}\nuser (1 s ago): Merge the session search one when the tests pass.`,
		pieces: [["Officials say the storm will reach the coast by Thursday evening.", false]],
		continuing: "Merge the session search one when the tests pass.",
	},
	// One slow sentence, cut at its pauses: the fragments go with the piece that is clearly for the Lead.
	{
		context: PRODUCT,
		pieces: [
			["In the web project send a task", true],
			["to check", true],
			["if agents are aware based on their", true],
			["instructions to use the browser extension", true],
		],
	},
	{ context: NETWORK_REPLY, pieces: [["What network issues?", true]] },
	// The voice handed it off, after a line to Mum: it heard the user turn back.
	{
		context: `${THREE_ASKS}\n${MUM}`,
		pieces: [[". Delete the old test box", true]],
		handedOff: true,
	},
	// The voice handed side talk off: still held.
	{ context: PRODUCT, pieces: [["Babe, did you feed the cat?", false]], handedOff: true },
	{ context: `${ASKED}\n${CAT}`, pieces: [["okok", false]], handedOff: true },
	{
		context: PRODUCT,
		pieces: [["Officials say the storm will reach the coast by Thursday evening.", false]],
		handedOff: true,
	},
	// The same contexts must not pull side talk in.
	{
		context: THREE_ASKS,
		pieces: [["Yeah, I'll move the umbrella to the balcony tomorrow, don't worry.", false]],
	},
	{ context: THREE_ASKS, pieces: [["Mum, can I call you back in five minutes?", false]] },
	{ context: NETWORK_REPLY, pieces: [["Yes, yes, I know, I'll bring it on Sunday.", false]] },
	{
		context: THREE_ASKS,
		pieces: [
			["Mum, hold on a second.", false],
			["And it can also stop the simulator.", true],
		],
	},
	{
		context: THREE_ASKS,
		pieces: [
			["Yeah, just put it next to the door.", false],
			["Delete the old test box.", true],
		],
	},
];

const provider: DecisionProvider = process.argv.includes("--provider")
	? (process.argv[process.argv.indexOf("--provider") + 1] as DecisionProvider)
	: "openrouter";
const apiKey = provider === "openai" ? openAiApiKey() : openRouterApiKey();
if (!apiKey) throw new Error(`No ${provider} key`);
console.log(
	`${provider}: ${CALL_GATE_MODEL[provider]}, send at p >= ${SEND_PROBABILITY[provider]}\n`,
);

/** What the call just raised, and what each piece should do with it. */
const CONFIRM = {
	kind: "confirm" as const,
	text: 'Send this to "Disk usage on the box page"? Use a friendly tone.',
};
const DECIDE = {
	kind: "decision" as const,
	text: "The email task asks: switch to managed sending, or keep bring-your-own keys? Options: Switch to managed sending; Keep bring-your-own; Decide later.",
};
const ASKED_OK = `user (20 s ago): Tell the disk usage task to use a friendly tone.
lead (6 s ago): I'll tell the disk usage task to use a friendly tone. It's waiting in the chat for your OK.`;
const RAISED = `lead (5 s ago): The email task needs a decision from you: switch to managed sending, or keep bring-your-own keys. It's waiting in the chat, take your time.`;
/** `answer`: what it must be; `never`: what it must not be (a correction may
 *  read as a no, which denies the card and still reaches the Lead, but never as
 *  a yes); `about`: whether it is on the topic at that kind's bar. */
type Want = { answer?: "approve" | "refuse" | null; never?: "approve"; about?: boolean };
/** A task's reply the voice just summed up in one line (lead-call.ts nudge). */
const REPLY_NETWORK: SpeechTopic = {
	kind: "reply",
	text: "The error report task says the agent skips the extension, partly because the box's network hits captchas.",
};
const REPLY_SEARCH: SpeechTopic = {
	kind: "reply",
	text: "The web search task says pinned orgs now search globally, since no search service runs in the EU yet.",
};
const TOPIC_CASES: {
	context: string;
	topic: SpeechTopic;
	piece: string;
	want: Want;
}[] = [
	{
		context: NETWORK_REPLY,
		topic: REPLY_NETWORK,
		piece: "What network issues?",
		want: { about: true },
	},
	{
		context: NETWORK_REPLY,
		topic: REPLY_NETWORK,
		piece: "Should we just tell every agent to use the extension then?",
		want: { about: true },
	},
	{
		context: NETWORK_REPLY,
		topic: REPLY_NETWORK,
		piece: "Babe, did you feed the cat?",
		want: { about: false },
	},
	{
		context: NETWORK_REPLY,
		topic: REPLY_NETWORK,
		piece: "What's in flight on the board?",
		want: { about: false },
	},
	{
		context: SEARCH_REPLY,
		topic: REPLY_SEARCH,
		piece: "Yeah, let's just go global and then maybe in the future once we have the EU",
		want: { about: true },
	},
	{ context: ASKED_OK, topic: CONFIRM, piece: "Yes, send it.", want: { answer: "approve" } },
	{ context: ASKED_OK, topic: CONFIRM, piece: "Go ahead.", want: { answer: "approve" } },
	{ context: ASKED_OK, topic: CONFIRM, piece: "Sure, do it.", want: { answer: "approve" } },
	{ context: ASKED_OK, topic: CONFIRM, piece: "No, don't send that.", want: { answer: "refuse" } },
	{ context: ASKED_OK, topic: CONFIRM, piece: "Wait, not yet.", want: { answer: "refuse" } },
	{
		context: ASKED_OK,
		topic: CONFIRM,
		piece: "Hmm, let me think about it.",
		want: { answer: null },
	},
	{
		context: ASKED_OK,
		topic: CONFIRM,
		piece: "Actually, make it formal instead.",
		want: { never: "approve" },
	},
	{
		context: ASKED_OK,
		topic: CONFIRM,
		piece: "What's in flight on the board?",
		// About a confirmation matters only with a yes or no, which this isn't.
		want: { answer: null },
	},
	{
		context: ASKED_OK,
		topic: CONFIRM,
		piece: "Babe, did you feed the cat?",
		want: { answer: null, about: false },
	},
	// Known: Jev reads this as a yes (2026-11-05); the 5 s spoken undo is there for it.
	{ context: `${ASKED_OK}\n${CAT}`, topic: CONFIRM, piece: "okok", want: { answer: null } },
	{
		context: RAISED,
		topic: DECIDE,
		piece: "Walk me through it.",
		want: { about: true, answer: null },
	},
	{
		context: RAISED,
		topic: DECIDE,
		piece: "What's the risk with the managed option?",
		want: { about: true, answer: null },
	},
	{
		context: RAISED,
		topic: DECIDE,
		piece: "Go with switching.",
		want: { about: true, answer: null },
	},
	{
		context: RAISED,
		topic: DECIDE,
		piece: "What's in flight on the board?",
		want: { about: false },
	},
];

/** A decision with buttons: the user's words may pick one ("go ahead" is the recommended). */
const DECIDE_OPTS = {
	kind: "decision" as const,
	text: "The email task asks: switch to managed sending, or keep bring-your-own keys?",
	options: [
		{
			label: "Switch to managed sending",
			recommended: true,
			description: "We send on our own account",
		},
		{ label: "Keep bring-your-own", description: "Customers keep their own keys" },
		{ label: "Decide later", description: "Check the numbers first" },
	],
};
const CHOICE_CASES: { piece: string; choice: number | null }[] = [
	{ piece: "Go ahead.", choice: 0 },
	{ piece: "Sounds good, do it.", choice: 0 },
	{ piece: "Keep it as it is.", choice: 1 },
	{ piece: "The second one.", choice: 1 },
	{ piece: "Let's decide later.", choice: 2 },
	{ piece: "Walk me through it.", choice: null },
	{ piece: "What's the risk with the managed option?", choice: null },
	{ piece: "Hmm, I'm not sure yet.", choice: null },
	{ piece: "Babe, did you feed the cat?", choice: null },
];

let right = 0;
let total = 0;
for (const c of CASES) {
	const started = Date.now();
	const verdicts = await judgeSpeech({
		model: { provider, apiKey },
		pieces: c.pieces.map(([text]) => text),
		context: c.context,
		...(c.continuing ? { continuing: c.continuing } : {}),
		...(c.handedOff ? { handedOff: true } : {}),
	});
	const ms = Date.now() - started;
	// What the call sends: the gate's verdicts through lead-call.ts rideAlong.
	const judged: Judged[] = c.pieces.map(([text], i) => ({
		text,
		lead: verdicts?.[i]?.send ?? false,
		kind: verdicts?.[i]?.kind ?? "unclear",
	}));
	// As lead-call.ts judgeBatch: across judgements, only the gate's answer carries on.
	const sends = new Set(rideAlong(judged).lead);
	c.pieces.forEach(([text, want], i) => {
		total++;
		const v = verdicts?.[i];
		const ok = v ? sends.has(text) === want : false;
		if (ok) right++;
		console.log(
			`${ok ? "ok  " : "MISS"} p=${v ? v.p.toFixed(2) : "null"} ${v?.kind ?? "-"}${sends.has(text) && !v?.send ? " (rides along)" : ""} want=${want ? "send" : "hold"}  ${ms}ms  "${text}"`,
		);
	});
}

/**
 * One utterance judged in several goes, as a slow speaker's pauses make the
 * call do: each go sees what the one before sent (a user line) or held (an
 * aside), and lead-call.ts rideAlong carries the utterance across. `want` is
 * all that must reach the Lead, in order.
 */
const SEQUENCES: { context: string; goes: string[]; want: string }[] = [
	{
		context: PRODUCT,
		goes: [
			"In the web project",
			"send a task",
			"to check",
			"if agents are aware",
			"based on their",
			"instructions",
			"to use the browser extension",
		],
		want: "In the web project send a task to check if agents are aware based on their instructions to use the browser extension",
	},
	{
		context: THREE_ASKS,
		goes: ["You can delete", "the box", "and it can also", "stop the simulator"],
		want: "You can delete the box and it can also stop the simulator",
	},
	{ context: THREE_ASKS, goes: ["Mum, hold on a second.", "Yeah, I'll call you back."], want: "" },
	{
		context: THREE_ASKS,
		goes: ["Delete the old test box.", "Yeah, just put it next to the door."],
		want: "Delete the old test box.",
	},
];
for (const sq of SEQUENCES) {
	// As lead-call.ts judgeBatch runs them: a held start is judged again with
	// what follows (withCarry), and what went is carried on (continuing).
	const lines: { text: string; held?: string }[] = [];
	let utter: Utterance | null = null;
	const sent: string[] = [];
	const log: string[] = [];
	for (const go of sq.goes) {
		const carry = withCarry([go], utter);
		const piece = carry.pieces[0] ?? go;
		const shown = lines.filter((l) => !(l.held && carry.carried.includes(l.held)));
		const v = (
			await judgeSpeech({
				model: { provider, apiKey },
				pieces: [piece],
				context: [sq.context, ...shown.map((l) => l.text)].join("\n"),
				...(utter?.sent ? { continuing: sent.join(" ") } : {}),
			})
		)?.[0];
		const plan = rideAlong([{ text: piece, lead: v?.send ?? false, kind: v?.kind ?? "unclear" }]);
		sent.push(...plan.lead);
		log.push(`${v ? v.p.toFixed(2) : "null"} ${v?.kind ?? "-"} "${piece}"`);
		lines.splice(0, lines.length, ...shown);
		if (plan.lead.length) lines.push({ text: `user (1 s ago): ${plan.lead.join(" ")}` });
		else lines.push({ text: `heard, not sent to the Lead (1 s ago): "${piece}"`, held: piece });
		const unclear = !plan.lead.length && (v?.kind ?? "unclear") === "unclear";
		utter = { sent: !!utter?.sent || plan.lead.length > 0, held: unclear ? [piece] : [] };
	}
	total++;
	const got = sent.join(" ");
	const ok = got === sq.want;
	if (ok) right++;
	console.log(
		`${ok ? "ok  " : "MISS"} sequence  got="${got}"  want="${sq.want}"\n       ${log.join("\n       ")}`,
	);
}
for (const c of TOPIC_CASES) {
	const started = Date.now();
	const v = (
		await judgeSpeech({
			model: { provider, apiKey },
			pieces: [c.piece],
			context: c.context,
			topic: c.topic,
		})
	)?.[0];
	const ms = Date.now() - started;
	total++;
	const okAnswer = c.want.answer === undefined || (v?.answer ?? null) === c.want.answer;
	const okNever = c.want.never === undefined || v?.answer !== c.want.never;
	const okAbout = c.want.about === undefined || !!v?.onTopic === c.want.about;
	const ok = !!v && okAnswer && okNever && okAbout;
	if (ok) right++;
	console.log(
		`${ok ? "ok  " : "MISS"} ${c.topic.kind.padEnd(8)} about=${v?.about?.toFixed(2) ?? "null"} answer=${v?.answer ?? "-"} send=${v?.send ?? "-"} want=${JSON.stringify(c.want)}  ${ms}ms  "${c.piece}"`,
	);
}
for (const c of CHOICE_CASES) {
	const started = Date.now();
	const v = (
		await judgeSpeech({
			model: { provider, apiKey },
			pieces: [c.piece],
			context: RAISED,
			topic: DECIDE_OPTS,
		})
	)?.[0];
	total++;
	const ok = !!v && (v.choice ?? null) === c.choice;
	if (ok) right++;
	console.log(
		`${ok ? "ok  " : "MISS"} choose   about=${v?.about?.toFixed(2) ?? "null"} choice=${v?.choice ?? "-"} want=${c.choice ?? "-"}  ${Date.now() - started}ms  "${c.piece}"`,
	);
}
console.log(`\n${right}/${total}`);
