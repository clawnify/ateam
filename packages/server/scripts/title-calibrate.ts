// Live calibration for task titles: launch prompts through the shipped
// generateTaskLabels, judged on one call the model makes: name the task from its
// words now, or wait for the agent's first reply (title null) because the words
// name no subject and only point at an attachment it cannot see. Then two
// first replies, which must always give a title.
//
// The cases are made up on purpose. Never paste real board prompts here: this
// repo is public. Calibrated 2026-11-04 on board prompts of the same shapes
// (14/14 on OpenRouter Haiku 5.5, OpenAI gpt-6-luna and Claude Code headless).
//
// Makes live calls (well under a cent). Run by hand:
//   bun packages/server/scripts/title-calibrate.ts                     (OpenRouter)
//   bun packages/server/scripts/title-calibrate.ts --provider openai   (OpenAI)
//   bun packages/server/scripts/title-calibrate.ts --provider claude   (Claude Code headless)
// Key: OPENROUTER_API_KEY, else ~/.ateam/credentials.json; OpenAI's from the file only.
import { describeAttachments, generateTaskLabels } from "@ateam/agents";
import { openAiApiKey, openRouterApiKey } from "../src/credentials-file";
import { readSettings } from "../src/settings-file";
import { askTextModel, resolveTextModel } from "../src/text-model";

type Expect = "name" | "wait";
const CASES: { words: string; files: string[]; expect: Expect }[] = [
	// Words that name no subject: wait for the reply.
	{
		words: "thoughts on this?",
		files: ["/att/Screenshot 2026-01-02 at 10.11.12.png"],
		expect: "wait",
	},
	{ words: "what happened here?", files: [], expect: "wait" },
	{ words: "can you check", files: ["/att/a.png", "/att/b.png"], expect: "wait" },
	{ words: "is this correct?", files: ["/att/proposal.pdf"], expect: "wait" },
	{ words: "same thing again", files: ["/att/shot.png"], expect: "wait" },
	// Words that name a subject, even with the details in an attachment: name now.
	{
		words: "the checkout button is cut off on mobile, see image",
		files: ["/att/shot.png"],
		expect: "name",
	},
	{ words: "the export job crashed with this error", files: ["/att/trace.png"], expect: "name" },
	{
		words: "why does the dashboard say synced when the calendar was never connected?",
		files: ["/att/shot.png"],
		expect: "name",
	},
	{ words: "keeps crashing on startup", files: [], expect: "name" },
	{ words: "remove stale feature flags", files: [], expect: "name" },
	{ words: "does the queue retry failed jobs?", files: [], expect: "name" },
	{ words: "what is that memory spike on the worker?", files: [], expect: "name" },
	{
		words: "these are from a competitor's landing page, I like how they animate the hero",
		files: ["/att/c.png"],
		expect: "name",
	},
];

const REPLIES: { words: string; reply: string }[] = [
	{
		words: "",
		reply:
			"The screenshot shows the settings page with the Save button hidden behind the footer on narrow windows.",
	},
	{
		words: "what happened here?",
		reply:
			"The nightly backup failed because the storage token expired on Monday, so the last three runs wrote nothing.",
	},
];

const flag = process.argv[process.argv.indexOf("--provider") + 1];
const provider = flag === "openai" || flag === "claude" ? flag : "openrouter";
// The models the app runs (Settings → AI), with only the provider chosen here.
const target = resolveTextModel(
	{ ...readSettings().settings.engine, textModel: provider },
	{ openRouter: openRouterApiKey(), openAi: openAiApiKey() },
);
if (!target) throw new Error(`no ${provider} key`);
console.log(`${"model" in target ? target.model : "Claude Code headless"} on ${provider}\n`);
// The launch's own budget (sessions.ts).
const ask = (prompt: string) => askTextModel(target, { prompt, maxTokens: 120, timeoutMs: 30_000 });

let agree = 0;
for (const c of CASES) {
	const t0 = Date.now();
	const labels = await generateTaskLabels(c.words, {
		attachments: describeAttachments(c.files),
		run: ask,
	});
	const got: Expect | "fail" = labels?.needsReply ? "wait" : labels?.title ? "name" : "fail";
	if (got === c.expect) agree++;
	console.log(
		`${got === c.expect ? "✓" : "✗"} ${got} (want ${c.expect}) ${Date.now() - t0}ms  ${JSON.stringify(c.words)}${c.files.length ? ` + ${describeAttachments(c.files)}` : ""}\n    title=${JSON.stringify(labels?.title ?? null)} tags=${JSON.stringify(labels?.tags ?? null)}`,
	);
}
console.log(`\n${agree}/${CASES.length} match\n`);

for (const r of REPLIES) {
	const labels = await generateTaskLabels(r.words, { reply: r.reply, run: ask });
	console.log(
		`${labels?.title ? "✓" : "✗"} from the reply: ${JSON.stringify(labels?.title ?? null)}`,
	);
}
