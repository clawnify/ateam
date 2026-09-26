import { afterEach, describe, expect, it } from "bun:test";
import { classifyTurn, decideStep, JEV_MODEL, type JevLegs } from "../src/jev";

const legs = (over: Partial<JevLegs>): JevLegs => ({
	asks_user: 0.02,
	blocked: 0.02,
	promises_future_work: 0.02,
	claims_done: 0.98,
	...over,
});

describe("decideStep", () => {
	it("keeps a finished turn in Review", () => {
		expect(decideStep(legs({})).step).toBe("review");
	});

	it("moves a turn that ends on a question to Needs you", () => {
		const v = decideStep(legs({ asks_user: 0.99, claims_done: 0.1 }));
		expect(v.step).toBe("needs_attention");
		expect(v.reason).toContain("waiting on your answer");
		expect(v.confidence).toBeCloseTo(0.98);
	});

	it("moves a blocked turn to Needs you", () => {
		expect(decideStep(legs({ blocked: 0.97, claims_done: 0.05 })).step).toBe("needs_attention");
	});

	it("moves a turn that stopped on a promise, but not one that finished first", () => {
		expect(decideStep(legs({ promises_future_work: 0.98, claims_done: 0.1 })).step).toBe(
			"needs_attention",
		);
		expect(decideStep(legs({ promises_future_work: 0.98, claims_done: 0.9 })).step).toBe("review");
	});

	it("leaves the card alone below the act threshold", () => {
		// 0.9 is confidence 0.8: a lean, not a certainty, so the rule stands.
		expect(decideStep(legs({ asks_user: 0.9 })).step).toBe("review");
	});

	it("reports the confidence of the answer that decided, not the weakest leg", () => {
		const v = decideStep(legs({ asks_user: 0.99, blocked: 0.5, claims_done: 0.5 }));
		expect(v.step).toBe("needs_attention");
		expect(v.confidence).toBeCloseTo(0.98);
	});
});

describe("classifyTurn", () => {
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
	const answers = (l: JevLegs) => ({
		answers: Object.fromEntries(Object.entries(l).map(([k, p]) => [k, { type: "noul", noul: p }])),
	});

	it("asks the pinned model at the decisions endpoint with the turn's text", async () => {
		const seen: { url?: string; init?: RequestInit } = {};
		stub(200, answers(legs({ asks_user: 0.99, claims_done: 0.1 })), seen);
		const v = await classifyTurn({
			apiKey: "sk-or-test",
			finalMessage: "Postgres or SQLite?",
			userMessage: "add a database",
		});
		expect(v?.step).toBe("needs_attention");
		expect(seen.url).toBe("https://openrouter.ai/api/alpha/decisions");
		const sent = JSON.parse(String(seen.init?.body));
		expect(sent.model).toBe(JEV_MODEL);
		expect(sent.state).toEqual({
			users_most_recent_message: "add a database",
			agents_final_message: "Postgres or SQLite?",
		});
		expect(Object.keys(sent.questions).sort()).toEqual(
			["asks_user", "blocked", "claims_done", "promises_future_work"].sort(),
		);
		expect((seen.init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-test");
	});

	it("is null on a failed call, so the rule's column stands", async () => {
		stub(401, { error: "bad key" });
		expect(await classifyTurn({ apiKey: "k", finalMessage: "done" })).toBeNull();
	});

	it("is null on an incomplete verdict rather than reading a missing answer as 0", async () => {
		stub(200, { answers: { asks_user: { noul: 0.99 } } });
		expect(await classifyTurn({ apiKey: "k", finalMessage: "done" })).toBeNull();
	});

	it("never calls out without a key or a message", async () => {
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response("{}");
		}) as unknown as typeof fetch;
		expect(await classifyTurn({ apiKey: "", finalMessage: "done" })).toBeNull();
		expect(await classifyTurn({ apiKey: "k", finalMessage: "  " })).toBeNull();
		expect(called).toBe(false);
	});
});
