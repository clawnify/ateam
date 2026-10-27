import { describe, expect, test } from "bun:test";
import { activeLabel, beginStep, failActive, relabelActive, waitingLabel } from "./connect-steps";

describe("connect steps", () => {
	test("a woken box that answers: each step closes as the next starts", () => {
		let s = beginStep([], "Waking the box through Sprites");
		s = beginStep(s, "Reaching Ateam on the box");
		s = relabelActive(s, waitingLabel(12_000));
		s = beginStep(s, "Loading projects");
		expect(s).toEqual([
			{ label: "Waking the box through Sprites", status: "done" },
			{ label: "Waiting for the box to answer, 12s", status: "done" },
			{ label: "Loading projects", status: "active" },
		]);
		expect(activeLabel(s)).toBe("Loading projects");
	});

	test("a wake that fails stays failed while the box is still tried", () => {
		let s = failActive(beginStep([], "Waking the box through Sprites"));
		s = beginStep(s, "Reaching Ateam on the box");
		expect(s.map((x) => x.status)).toEqual(["failed", "active"]);
	});

	test("a box that never answers: the wait is the failed step, the wake stays done", () => {
		let s = beginStep([], "Waking the box through boxd");
		s = beginStep(s, "Reaching Ateam on the box");
		s = failActive(s);
		expect(s.map((x) => x.status)).toEqual(["done", "failed"]);
		expect(activeLabel(s)).toBeNull();
	});

	test("the active step is the one in flight", () => {
		const s = beginStep(beginStep([], "a"), "b");
		expect(activeLabel(s)).toBe("b");
	});

	test("the wait counts in seconds, then minutes", () => {
		expect(waitingLabel(0)).toBe("Waiting for the box to answer, 0s");
		expect(waitingLabel(59_900)).toBe("Waiting for the box to answer, 59s");
		expect(waitingLabel(65_000)).toBe("Waiting for the box to answer, 1m 05s");
	});
});
