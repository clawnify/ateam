import { describe, expect, it } from "bun:test";
import { type SetStatusRequest, validateSetStatus } from "../src/main/loops/board-organizer";

const req = (over: Partial<SetStatusRequest>): SetStatusRequest => ({
	taskId: "t1",
	from: "todo",
	to: "review",
	agentAlive: false,
	...over,
});

describe("validateSetStatus — the guardrail", () => {
	it("allows a legit organizer triage move between assignable columns", () => {
		const v = validateSetStatus(req({ from: "review", to: "todo", reason: "stale" }));
		expect(v.ok).toBe(true);
		if (v.ok) {
			expect(v.change.to).toBe("todo");
			expect(v.change.reason).toBe("stale");
		}
	});

	it("defaults the organizer's reason so the audit trail is never empty", () => {
		const v = validateSetStatus(req({ reason: "  " }));
		if (v.ok) expect(v.change.reason).toBe("organizer re-triage");
	});

	it("refuses non-assignable targets — running / merged / needs_attention", () => {
		expect(validateSetStatus(req({ to: "running" })).ok).toBe(false);
		expect(validateSetStatus(req({ to: "merged" })).ok).toBe(false);
		// needs_attention is programmatic (set when the agent blocks on input).
		expect(validateSetStatus(req({ to: "needs_attention" })).ok).toBe(false);
	});

	it("organizer cannot move a card out of a programmatic column", () => {
		for (const from of ["running", "needs_attention", "merged"] as const) {
			const v = validateSetStatus(req({ from, to: "review" }));
			expect(v.ok).toBe(false);
		}
	});

	it("organizer never touches a card with a live agent", () => {
		const v = validateSetStatus(req({ from: "todo", to: "review", agentAlive: true }));
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.reason).toContain("live agent");
	});

	it("rejects a no-op move", () => {
		const v = validateSetStatus(req({ from: "review", to: "review" }));
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.reason).toContain("no-op");
	});

	describe("self-moves (a session moving its own card)", () => {
		it("lets a live session move its own running card to review", () => {
			const v = validateSetStatus({
				taskId: "t1",
				from: "running",
				to: "review",
				agentAlive: true,
				bySelf: true,
				reason: "finished",
			});
			expect(v.ok).toBe(true);
			if (v.ok) expect(v.change.reason).toBe("finished");
		});

		it("defaults a self-move reason distinctly from the organizer's", () => {
			const v = validateSetStatus({
				taskId: "t1",
				from: "running",
				to: "review",
				agentAlive: true,
				bySelf: true,
			});
			if (v.ok) expect(v.change.reason).toBe("session self-move");
		});

		it("still cannot un-merge its own card", () => {
			const v = validateSetStatus({
				taskId: "t1",
				from: "merged",
				to: "review",
				agentAlive: true,
				bySelf: true,
			});
			expect(v.ok).toBe(false);
			if (!v.ok) expect(v.reason).toContain("merged");
		});

		it("still cannot set a programmatic target", () => {
			const v = validateSetStatus({
				taskId: "t1",
				from: "running",
				to: "needs_attention",
				agentAlive: true,
				bySelf: true,
			});
			expect(v.ok).toBe(false);
		});
	});
});
