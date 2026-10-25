import { afterEach, describe, expect, it } from "bun:test";
import {
	GRAMMAR_JEV_MODEL,
	type GrammarJudgeIssue,
	judgeGrammar,
	looksSecret,
} from "../src/grammar-jev";

/** An issue on the first occurrence of `word` in `draft`. */
const issue = (draft: string, word: string): GrammarJudgeIssue => {
	const start = draft.indexOf(word);
	return {
		start,
		end: start + word.length,
		problem: word,
		message: `Did you mean to spell \`${word}\` this way?`,
		suggestions: ["x"],
	};
};

describe("looksSecret", () => {
	it("catches keys and tokens", () => {
		expect(looksSecret("use sk-or-v1-abcdef0123456789 for it")).toBe(true);
		expect(looksSecret("token ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe(true);
		expect(looksSecret("the sha 3f9a1c0be47d2a6f9e8b7c6d5a4b3c2d1e0f9a8b")).toBe(true);
	});

	it("lets ordinary prompts through, paths and long names included", () => {
		expect(looksSecret("fix the bug wich breaks the build")).toBe(false);
		expect(looksSecret("look at apps/desktop/src/renderer/src/grammar/filter.ts")).toBe(false);
		expect(looksSecret("rename syncEngineSettingsToBoxesEverywhereAtOnce")).toBe(false);
	});
});

describe("judgeGrammar", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	/** Answers each question with the probability for the word it quotes. */
	function stub(probs: Record<string, number>, calls: { body: unknown }[] = [], status = 200) {
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body));
			calls.push({ body });
			const answers = Object.fromEntries(
				Object.entries(body.questions as Record<string, { instructions: string }>).map(
					([id, q]) => {
						const word = Object.keys(probs).find((w) => q.instructions.includes(`"${w}" a real`));
						return [id, { type: "noul", noul: word === undefined ? 0.5 : probs[word] }];
					},
				),
			);
			return new Response(JSON.stringify({ answers }), { status });
		}) as unknown as typeof fetch;
	}

	it("keeps real mistakes and hides noise, in the order given", async () => {
		const calls: { body: unknown }[] = [];
		stub({ wich: 0.95, lol: 0.05 }, calls);
		const draft = "fix the bug wich breaks the build lol";
		const v = await judgeGrammar({
			apiKey: "k",
			draft,
			issues: [issue(draft, "wich"), issue(draft, "lol")],
		});
		expect(v?.map((x) => x.keep)).toEqual([true, false]);
		expect(calls).toHaveLength(1);
		const sent = calls[0]?.body as { model: string; state: unknown };
		expect(sent.model).toBe(GRAMMAR_JEV_MODEL);
		expect(sent.state).toEqual({ draft_prompt: draft });
	});

	it("asks only about words it hasn't judged as the draft grows", async () => {
		const calls: { body: unknown }[] = [];
		stub({ outide: 0.97, pls: 0.1 }, calls);
		const a = "close the modal when you click outide it";
		await judgeGrammar({ apiKey: "k", draft: a, issues: [issue(a, "outide")] });
		const b = `${a} pls`;
		const v = await judgeGrammar({
			apiKey: "k",
			draft: b,
			issues: [issue(b, "outide"), issue(b, "pls")],
		});
		expect(v?.map((x) => x.keep)).toEqual([true, false]);
		expect(calls).toHaveLength(2);
		const second = calls[1]?.body as { questions: Record<string, unknown> };
		expect(Object.keys(second.questions)).toHaveLength(1);
	});

	it("is null on a failed call, so every issue shows", async () => {
		stub({}, [], 500);
		const draft = "teh sidebar wont collapse";
		expect(await judgeGrammar({ apiKey: "k", draft, issues: [issue(draft, "teh")] })).toBeNull();
	});

	it("never sends a draft that may hold a secret, or calls out with nothing to ask", async () => {
		const calls: { body: unknown }[] = [];
		stub({ wrod: 0.9 }, calls);
		const secret = "set sk-or-v1-abcdef0123456789 and fix the wrod";
		expect(
			await judgeGrammar({ apiKey: "k", draft: secret, issues: [issue(secret, "wrod")] }),
		).toBeNull();
		expect(await judgeGrammar({ apiKey: "k", draft: "fine", issues: [] })).toBeNull();
		expect(
			await judgeGrammar({ apiKey: "", draft: "a wrod", issues: [issue("a wrod", "wrod")] }),
		).toBeNull();
		expect(calls).toHaveLength(0);
	});
});
