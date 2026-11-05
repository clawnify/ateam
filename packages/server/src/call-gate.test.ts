import { expect, test } from "bun:test";
import { judgeSpeech, verdictOf } from "./call-gate";

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
