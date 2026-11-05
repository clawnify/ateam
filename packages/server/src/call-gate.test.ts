import { expect, test } from "bun:test";
import { answerOf, choiceOf, judgeSpeech, verdictOf } from "./call-gate";

test("verdictOf sends at the bar and names what the rest most likely was", () => {
	expect(verdictOf({ lead: 0.9, someone: 0.1, background: 0 }, 0.7)).toEqual({
		p: 0.9,
		send: true,
		kind: "lead",
	});
	expect(verdictOf({ lead: 0.2, someone: 0.9, background: 0.1 }, 0.7).kind).toBe("someone");
	expect(verdictOf({ lead: 0.1, someone: 0.6, background: 0.8 }, 0.7).kind).toBe("background");
	expect(verdictOf({ lead: 0.5, someone: 0.3, background: 0.2 }, 0.7)).toEqual({
		p: 0.5,
		send: false,
		kind: "unclear",
	});
});

test("judgeSpeech asks nothing without a key or without speech", async () => {
	expect(
		await judgeSpeech({ model: { provider: "openai", apiKey: "" }, pieces: ["hi"], context: "" }),
	).toBeNull();
	expect(
		await judgeSpeech({ model: { provider: "openai", apiKey: "k" }, pieces: [], context: "" }),
	).toBeNull();
});

test("answerOf: a no wins a tie and needs only 0.5; a yes needs the bar; off-topic is neither", () => {
	expect(answerOf({ about: 0.9, approve: 0.97, refuse: 0.02 }, 0.6)).toBe("approve");
	expect(answerOf({ about: 0.9, approve: 0.55, refuse: 0.1 }, 0.6)).toBeNull();
	expect(answerOf({ about: 0.9, approve: 0.6, refuse: 0.6 }, 0.6)).toBe("refuse");
	expect(answerOf({ about: 0.9, approve: 0.1, refuse: 0.8 }, 0.6)).toBe("refuse");
	expect(answerOf({ about: 0.3, approve: 0.99, refuse: 0 }, 0.6)).toBeNull();
});

test("choiceOf picks only a clear winner above the bar, on topic", () => {
	expect(choiceOf(0.9, [0.92, 0.1, 0.05], 0.7)).toBe(0);
	expect(choiceOf(0.9, [0.8, 0.7, 0.1], 0.7)).toBeNull(); // two could be meant
	expect(choiceOf(0.9, [0.6, 0.1], 0.7)).toBeNull(); // not sure enough
	expect(choiceOf(0.3, [0.95, 0.1], 0.7)).toBeNull(); // not about the decision
	expect(choiceOf(0.9, [], 0.7)).toBeNull();
});
