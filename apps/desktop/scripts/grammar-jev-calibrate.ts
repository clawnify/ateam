// Live calibration for Jev's grammar filter: prompt drafts through Harper and
// the toolbar's own filter, exactly as the terminal sees them, then through
// the shipped judgeGrammar, printed with each issue's probability so the
// question and KEEP_PROBABILITY can be judged against real answers.
//
// Makes live OpenRouter calls (a fraction of a cent in all). Run by hand:
//   cd apps/desktop && bun scripts/grammar-jev-calibrate.ts
// Key: OPENROUTER_API_KEY, else ~/.ateam/credentials.json.
import { LocalLinter } from "harper.js";
import { binary } from "harper.js/binary";
import { openRouterApiKey } from "../../../packages/server/src/credentials-file";
import { judgeGrammar } from "../../../packages/server/src/grammar-jev";
import { issuesToShow } from "../src/renderer/src/grammar/filter";

/** Per flagged word: true = a real mistake to show, false = noise to hide. */
const CASES: { draft: string; expect: Record<string, boolean> }[] = [
	{ draft: "fix the bug wich breaks the build lol", expect: { wich: true, lol: false } },
	{ draft: "make the toast less shouty, its fine to drop the icon", expect: { shouty: false } },
	{ draft: "teh sidebar dosent collapse on mobile", expect: { teh: true, dosent: true } },
	{
		draft: "can you dedupe the reqs before we hit the api",
		expect: { dedupe: false, reqs: false },
	},
	{ draft: "the modal should close when you click outide it", expect: { outide: true } },
	{
		draft: "wire up supabase auth and nuke the old firebase stuff",
		expect: { supabase: false, firebase: false, nuke: false },
	},
	{
		draft: "refactor the reciever so it handles retrys",
		expect: { reciever: true, retrys: true },
	},
	{ draft: "add a lil spinner while it loads, nothing fancy", expect: { lil: false } },
	{ draft: "their are two places where we parse the config", expect: { their: true } },
	{ draft: "pls bump the timeout, its way to short", expect: { pls: false, to: true } },
	{ draft: "the onboarding flow feels janky, smooth it out", expect: { janky: false } },
	{ draft: "why does the build take so long, it use to be fast", expect: { use: true } },
	{
		draft: "ok so basically gonna need a cron that pings the box every 5 mins",
		expect: { gonna: false, mins: false },
	},
	{ draft: "the setings page dosn't save the toggle", expect: { setings: true, "dosn't": true } },
	{ draft: "kill the flaky e2e test and lmk what breaks", expect: { lmk: false, flaky: false } },
	{ draft: "the agent keeps loosing the draft when i paste", expect: { loosing: true } },
];

const key = openRouterApiKey();
if (!key) throw new Error("no OpenRouter key");
const linter = new LocalLinter({ binary });

let agree = 0;
let judged = 0;
for (const c of CASES) {
	const lints = await linter.lint(c.draft, { language: "markdown" });
	const issues = issuesToShow(
		c.draft,
		lints.map((l) => ({
			start: l.span().start,
			end: l.span().end,
			problem: l.get_problem_text(),
			message: l.message(),
			kind: l.lint_kind(),
			suggestions: l.suggestions().map((s) => ({ label: s.get_replacement_text(), result: "" })),
		})),
	);
	if (issues.length === 0) {
		console.log(`· ${c.draft}\n    Harper flags nothing`);
		continue;
	}
	const t0 = Date.now();
	const verdicts = await judgeGrammar({
		apiKey: key,
		draft: c.draft,
		issues: issues.map((i) => ({ ...i, suggestions: i.suggestions.map((s) => s.label) })),
	});
	const ms = Date.now() - t0;
	if (!verdicts) {
		console.log(`✗ ${c.draft}: NO VERDICT (${ms}ms)`);
		continue;
	}
	console.log(`· ${c.draft} (${ms}ms)`);
	issues.forEach((issue, i) => {
		const v = verdicts[i];
		if (!v) return;
		const want = c.expect[issue.problem];
		let mark = "?";
		if (want !== undefined) {
			judged++;
			if (want === v.keep) agree++;
			mark = want === v.keep ? "✓" : "✗";
		}
		console.log(
			`    ${mark} ${issue.problem} [${issue.kind}] p=${v.p.toFixed(2)} ${v.keep ? "show" : "hide"}${want === undefined ? "" : ` (want ${want ? "show" : "hide"})`}`,
		);
	});
}
console.log(`\n${agree}/${judged} match`);
