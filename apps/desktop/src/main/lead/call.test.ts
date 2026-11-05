import { expect, test } from "bun:test";
import { seedInput } from "./call";

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
