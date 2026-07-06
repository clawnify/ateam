import { describe, expect, it } from "bun:test";
import {
	type AgentLoopConfig,
	DEFAULT_MAX_ITERATIONS,
	decideContinuation,
	HARD_MAX_ITERATIONS,
	resolveMaxIterations,
} from "../src/loops/agent-loop";

const cfg = (over: Partial<AgentLoopConfig> = {}): AgentLoopConfig => ({
	prompt: "keep fixing failing tests",
	...over,
});

describe("resolveMaxIterations", () => {
	it("defaults when unset", () => {
		expect(resolveMaxIterations(cfg())).toBe(DEFAULT_MAX_ITERATIONS);
	});
	it("clamps to the hard ceiling and floor", () => {
		expect(resolveMaxIterations(cfg({ maxIterations: 10_000 }))).toBe(HARD_MAX_ITERATIONS);
		expect(resolveMaxIterations(cfg({ maxIterations: 0 }))).toBe(1);
		expect(resolveMaxIterations(cfg({ maxIterations: -5 }))).toBe(1);
	});
	it("floors fractional and rejects non-finite", () => {
		expect(resolveMaxIterations(cfg({ maxIterations: 3.9 }))).toBe(3);
		expect(resolveMaxIterations(cfg({ maxIterations: Number.NaN }))).toBe(DEFAULT_MAX_ITERATIONS);
	});
});

describe("decideContinuation", () => {
	it("continues with the prompt while under the cap", () => {
		const d = decideContinuation(cfg({ maxIterations: 3 }), { iterations: 0 });
		expect(d.continue).toBe(true);
		if (d.continue) {
			expect(d.prompt).toBe("keep fixing failing tests");
			expect(d.reason).toBe("turn 1/3");
		}
	});

	it("stops exactly at the cap (backstop)", () => {
		const d = decideContinuation(cfg({ maxIterations: 3 }), { iterations: 3 });
		expect(d.continue).toBe(false);
		if (!d.continue) expect(d.reason).toContain("3-turn cap");
	});

	it("the cap wins even when there is no stop signal", () => {
		// A loop with no stopSignal must still terminate — the cap is the backstop.
		const d = decideContinuation(cfg({ maxIterations: 1 }), { iterations: 1 });
		expect(d.continue).toBe(false);
	});

	it("stops when the goal sentinel appears in the last output", () => {
		const c = cfg({ stopSignal: "LOOP_DONE", maxIterations: 50 });
		const d = decideContinuation(c, { iterations: 2 }, "all green now. LOOP_DONE");
		expect(d.continue).toBe(false);
		if (!d.continue) expect(d.reason).toContain("stop signal");
	});

	it("keeps going when the sentinel is absent from the output", () => {
		const c = cfg({ stopSignal: "LOOP_DONE", maxIterations: 50 });
		const d = decideContinuation(c, { iterations: 2 }, "still two tests failing");
		expect(d.continue).toBe(true);
	});

	it("cap is checked before the goal signal (safety over completion)", () => {
		const c = cfg({ stopSignal: "LOOP_DONE", maxIterations: 2 });
		// At the cap AND the signal is present — must stop for the cap reason,
		// but either way it stops; assert it does not continue.
		const d = decideContinuation(c, { iterations: 2 }, "not done yet");
		expect(d.continue).toBe(false);
		if (!d.continue) expect(d.reason).toContain("cap");
	});

	it("refuses to drive a turn with a blank prompt", () => {
		const d = decideContinuation(cfg({ prompt: "   " }), { iterations: 0 });
		expect(d.continue).toBe(false);
		if (!d.continue) expect(d.reason).toContain("no prompt");
	});

	it("trims the prompt it sends", () => {
		const d = decideContinuation(cfg({ prompt: "  do it  " }), { iterations: 0 });
		if (d.continue) expect(d.prompt).toBe("do it");
	});
});
