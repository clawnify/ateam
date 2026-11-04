import { afterEach, describe, expect, it } from "bun:test";
import { askDecisions, resolveDecisionModel } from "../src/decision-model";

describe("resolveDecisionModel", () => {
	const both = { openRouter: "sk-or", openAi: "sk-proj" };

	it("auto takes Jev when the OpenRouter key is set, else Luna, else nothing", () => {
		expect(resolveDecisionModel({ decisionModel: "auto" }, both)?.provider).toBe("openrouter");
		expect(resolveDecisionModel({ decisionModel: "auto" }, { openAi: "sk-proj" })).toEqual({
			provider: "openai",
			apiKey: "sk-proj",
		});
		expect(resolveDecisionModel({ decisionModel: "auto" }, {})).toBeNull();
	});

	it("a chosen provider needs its own key, and never falls back to the other", () => {
		expect(resolveDecisionModel({ decisionModel: "openai" }, both)?.provider).toBe("openai");
		expect(resolveDecisionModel({ decisionModel: "openai" }, { openRouter: "sk-or" })).toBeNull();
		expect(resolveDecisionModel({ decisionModel: "openrouter" }, { openAi: "sk-proj" })).toBeNull();
	});

	it("off asks nobody, and an unknown value reads as auto", () => {
		expect(resolveDecisionModel({ decisionModel: "off" }, both)).toBeNull();
		expect(
			resolveDecisionModel({ decisionModel: "bogus" as "auto" }, { openAi: "sk-proj" })?.provider,
		).toBe("openai");
	});
});

describe("askDecisions on OpenAI", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	function stub(status: number, body: unknown, seen?: { url?: string; init?: RequestInit }) {
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			if (seen) Object.assign(seen, { url, init });
			return new Response(JSON.stringify(body), { status });
		}) as unknown as typeof fetch;
	}
	const ask = () =>
		askDecisions({
			target: { provider: "openai", apiKey: "sk-proj-test" },
			model: "gpt-6-luna",
			state: { agents_final_message: "Postgres or SQLite?" },
			questions: {
				asks_user: {
					instructions: "Does it ask the user something?",
					criteria: { true: "Waiting on the user.", false: "Reports on work." },
				},
				claims_done: { instructions: "Is the work finished?" },
			},
			timeoutMs: 1_000,
		});

	it("sends predicates by name, criteria folded into the instructions, the state as named sections", async () => {
		const seen: { url?: string; init?: RequestInit } = {};
		stub(
			200,
			{
				answers: [
					{ type: "predicate", name: "claims_done", probability: 0.1 },
					{ type: "predicate", name: "asks_user", probability: 0.97 },
				],
			},
			seen,
		);
		expect(await ask()).toEqual({ asks_user: 0.97, claims_done: 0.1 });
		expect(seen.url).toBe("https://api.openai.com/v1/decisions");
		const headers = seen.init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer sk-proj-test");
		// OpenRouter's attribution headers are OpenRouter's alone.
		expect(headers["X-Title"]).toBeUndefined();
		const sent = JSON.parse(String(seen.init?.body));
		expect(sent).toEqual({
			model: "gpt-6-luna",
			input: "<agents_final_message>\nPostgres or SQLite?\n</agents_final_message>",
			questions: [
				{
					type: "predicate",
					name: "asks_user",
					instructions:
						"Does it ask the user something?\nTrue: Waiting on the user.\nFalse: Reports on work.",
				},
				{ type: "predicate", name: "claims_done", instructions: "Is the work finished?" },
			],
		});
	});

	it("is null when an answer is refused or missing, never reading it as 0", async () => {
		stub(200, {
			answers: [
				{ type: "refusal", name: "asks_user" },
				{ type: "predicate", name: "claims_done", probability: 0.1 },
			],
		});
		expect(await ask()).toBeNull();
		stub(200, { answers: [{ type: "predicate", name: "claims_done", probability: 0.1 }] });
		expect(await ask()).toBeNull();
	});

	it("is null on a failed call", async () => {
		stub(401, { error: { message: "Incorrect API key" } });
		expect(await ask()).toBeNull();
	});
});
