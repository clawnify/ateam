// Live calibration for the board classifier: real closing messages through the
// shipped classifyTurn, printed with each question's probability so the
// questions and MOVE_CONFIDENCE can be judged against real answers.
//
// Makes live OpenRouter calls (a few hundredths of a cent). Run by hand:
//   bun packages/server/scripts/jev-calibrate.ts
// Key: OPENROUTER_API_KEY, else ~/.ateam/credentials.json.
import { openRouterApiKey } from "../src/credentials-file";
import { classifyTurn } from "../src/jev";

type Expect = "review" | "needs_attention";
const CASES: { name: string; user: string; final: string; expect: Expect }[] = [
	{
		name: "question: pick an option",
		user: "add a database to the app",
		final:
			"I can wire this up two ways: Postgres via Supabase, or SQLite with Drizzle. Which do you prefer?",
		expect: "needs_attention",
	},
	{
		name: "done: PR opened",
		user: "fix the login redirect bug",
		final: "Fixed. The redirect now preserves the `next` param. Tests pass and I opened PR #261.",
		expect: "review",
	},
	{
		name: "done + optional offer",
		user: "add dark mode",
		final:
			"Dark mode is in: tokens on :root, a toggle in settings, and tests. Want me to also add a keyboard shortcut for it?",
		expect: "review",
	},
	{
		name: "stalled on a promise",
		user: "migrate the API to v2",
		final: "I've read the v1 handlers. Next I'll update the routes and run the test suite.",
		expect: "needs_attention",
	},
	{
		name: "blocked: missing credentials",
		user: "deploy the worker",
		final:
			"The deploy failed: wrangler says the API token is missing. I can't continue without CLOUDFLARE_API_TOKEN set.",
		expect: "needs_attention",
	},
	{
		name: "asks approval for destructive step",
		user: "clean up old branches",
		final:
			"Found 14 merged branches. Deleting them is irreversible on the remote. Should I go ahead and delete all 14?",
		expect: "needs_attention",
	},
	{
		name: "answered a question (no action asked)",
		user: "why is the build slow?",
		final:
			"Most of the time is type-checking the renderer: tsc runs twice because both vite and the typecheck script invoke it.",
		expect: "review",
	},
	{
		name: "summary of changes, long",
		user: "refactor the settings panel",
		final:
			"Summary of changes:\n- Rows are data in ROWS\n- Search filters across sections\n- Values save on change\n\nAll 328 tests pass and typecheck is clean.",
		expect: "review",
	},
	{
		name: "failed tests it could not fix",
		user: "make the flaky test pass",
		final:
			"I tried three approaches but `ws.test.ts` still times out intermittently in CI; I could not find the root cause.",
		expect: "needs_attention",
	},
	{
		name: "done + generic closer",
		user: "rename the config key",
		final:
			"Renamed `hookPort` to `hook_port` everywhere and updated the tests. Let me know if you'd like any changes.",
		expect: "review",
	},
	{
		name: "done + I'll watch CI",
		user: "bump the node version",
		final:
			"Bumped to Node 22 in .nvmrc and the workflow, and pushed. I'll keep an eye on CI once it runs.",
		expect: "review",
	},
	{
		name: "plan awaiting go-ahead",
		user: "add rate limiting",
		final:
			"Plan:\n1. Token bucket per API key in the worker\n2. 429 with Retry-After\n3. Tests for burst and refill\n\nShall I proceed?",
		expect: "needs_attention",
	},
];

const key = openRouterApiKey();
if (!key) throw new Error("no OpenRouter key");

let agree = 0;
for (const c of CASES) {
	const t0 = Date.now();
	const v = await classifyTurn({ apiKey: key, finalMessage: c.final, userMessage: c.user });
	const ms = Date.now() - t0;
	if (!v) {
		console.log(`✗ ${c.name}: NO VERDICT (${ms}ms)`);
		continue;
	}
	const ok = v.step === c.expect;
	if (ok) agree++;
	const legs = Object.entries(v.legs)
		.map(([k, p]) => `${k}=${p.toFixed(2)}`)
		.join(" ");
	console.log(`${ok ? "✓" : "✗"} ${c.name}: ${v.step} (want ${c.expect}) ${ms}ms\n    ${legs}`);
}
console.log(`\n${agree}/${CASES.length} match`);
