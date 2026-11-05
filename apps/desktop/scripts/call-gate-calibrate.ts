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
} from "../../../packages/server/src/call-gate";
import { openAiApiKey, openRouterApiKey } from "../../../packages/server/src/credentials-file";
import type { DecisionProvider } from "../../../packages/server/src/decision-model";

const PRODUCT = `user: What's in flight on the board?
lead: Two tasks are running: the onboarding checklist and faster session search. The checklist agent asked which tone to use.`;
const NONE = "";
/** The Lead asked a yes/no 25 s ago; contexts carry ages as lead-call.ts's contextFrom writes them. */
const ASKED = `user (34 s ago): Tell the checklist agent to use a friendly tone.
lead (25 s ago): I can message the checklist task now and tell it to switch to a friendly tone. Should I go ahead?`;
const JUST_ASKED = `user (12 s ago): Tell the checklist agent to use a friendly tone.
lead (3 s ago): I can message the checklist task now and tell it to switch to a friendly tone. Should I go ahead?`;
const CAT = `heard, not sent to the Lead (4 s ago), said to someone else in the room: "Did you give food to the cat?"`;

/** Each piece of speech, and whether it should reach the Lead. */
const CASES: { context: string; pieces: [string, boolean][] }[] = [
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
const TOPIC_CASES: {
	context: string;
	topic: typeof CONFIRM | typeof DECIDE;
	piece: string;
	want: Want;
}[] = [
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
	});
	const ms = Date.now() - started;
	c.pieces.forEach(([text, want], i) => {
		total++;
		const v = verdicts?.[i];
		const ok = v ? v.send === want : false;
		if (ok) right++;
		console.log(
			`${ok ? "ok  " : "MISS"} p=${v ? v.p.toFixed(2) : "null"} ${v?.kind ?? "-"} want=${want ? "send" : "hold"}  ${ms}ms  "${text}"`,
		);
	});
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
