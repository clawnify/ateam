import { expect, test } from "bun:test";
import { headlineOf, needWords, nudgePrompt, seedInput } from "./call";

test("seedInput keeps the newest turns that fit, oldest first, in OpenAI's message shape", () => {
	const turns = [
		{ role: "user" as const, text: "first" },
		{ role: "assistant" as const, text: "second" },
		{ role: "developer" as const, text: "  " },
		{ role: "developer" as const, text: "a task replied" },
	];
	expect(seedInput(turns)).toEqual([
		{ role: "user", content: [{ type: "input_text", text: "first" }] },
		{ role: "assistant", content: [{ type: "output_text", text: "second" }] },
		{ role: "developer", content: [{ type: "input_text", text: "a task replied" }] },
	]);
});

test("seedInput stays under OpenAI's caps: 128 messages and about 8,192 tokens", () => {
	const many = Array.from({ length: 300 }, (_, i) => ({
		role: "user" as const,
		text: `turn ${i}`,
	}));
	const seeded = seedInput(many) as { content: { text: string }[] }[];
	expect(seeded.length).toBe(128);
	expect(seeded.at(-1)?.content[0]?.text).toBe("turn 299");
	const big = Array.from({ length: 10 }, (_, i) => ({
		role: "user" as const,
		text: `${i}${"x".repeat(5000)}`,
	}));
	const kept = seedInput(big) as { content: { text: string }[] }[];
	expect(kept.length).toBe(4);
	expect(kept[0]?.content[0]?.text.startsWith("6")).toBe(true);
});

test("nudgePrompt asks for a short headline only, no verdict", () => {
	const p = nudgePrompt("Faster session search", "Done: search is 3x faster. PR 511 is up.");
	expect(p).toContain('the task "Faster session search"');
	expect(p).toContain("at most 14 words");
	expect(p).toContain("no verdict");
	expect(p).toEndWith("Done: search is 3x faster. PR 511 is up.");
	expect(nudgePrompt("t", "x".repeat(9000)).length).toBeLessThan(5000);
});

test("headlineOf cleans the model's line; needWords speaks the board classifier's verdict", () => {
	expect(headlineOf('"**Search made three times faster**."\nextra')).toBe(
		"Search made three times faster",
	);
	expect(headlineOf(null)).toBe("");
	const legs = { asks_user: 0.9, blocked: 0.1, promises_future_work: 0.1, claims_done: 0.9 };
	expect(needWords({ step: "needs_attention", legs })).toBe("It's waiting on your answer.");
	expect(
		needWords({ step: "needs_attention", legs: { ...legs, asks_user: 0.1, blocked: 0.9 } }),
	).toBe("It says it's blocked.");
	expect(needWords({ step: "review", legs })).toBe("");
	expect(needWords(null)).toBe("");
});
