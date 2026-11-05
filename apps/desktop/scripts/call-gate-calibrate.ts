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
console.log(`\n${right}/${total}`);
