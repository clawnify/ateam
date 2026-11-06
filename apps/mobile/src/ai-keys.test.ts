// The AI keys page's fields and the checks on a pasted key.
import { describe, expect, test } from "bun:test";
import { AI_KEY_FIELDS, cleanKey, savedKeyLine, wrongField } from "./ai-keys";

describe("AI keys", () => {
	test("OpenAI first, OpenRouter optional, each saved as its own credentials field", () => {
		expect(AI_KEY_FIELDS.map((f) => [f.provider, f.field, f.optional])).toEqual([
			["openAi", "openAiApiKey", false],
			["openRouter", "openRouterApiKey", true],
		]);
		for (const f of AI_KEY_FIELDS) expect(f.console.url.startsWith("https://")).toBe(true);
	});

	test("a pasted key loses the spaces and line breaks a copy brought", () => {
		expect(cleanKey("  sk-abc\n123 \t")).toBe("sk-abc123");
	});

	test("a key pasted in the other provider's field says so", () => {
		expect(wrongField("openAi", "sk-or-v1-abc")).toContain("OpenRouter key");
		expect(wrongField("openRouter", "sk-proj-abc")).toContain("OpenAI key");
		expect(wrongField("openAi", "sk-proj-abc")).toBeNull();
		expect(wrongField("openRouter", " sk-or-v1-abc")).toBeNull();
		// Not a known shape either way: the provider will say whether it works.
		expect(wrongField("openAi", "something-else")).toBeNull();
	});

	test("a saved key shows only its last four, and where it comes from", () => {
		expect(savedKeyLine({ set: true, hint: "ABCD", source: "file" })).toBe("Saved ····ABCD");
		expect(savedKeyLine({ set: true, hint: "WXYZ", source: "env" })).toBe(
			"From the box's environment ····WXYZ",
		);
		expect(savedKeyLine({ set: true })).toBe("Saved");
	});
});
