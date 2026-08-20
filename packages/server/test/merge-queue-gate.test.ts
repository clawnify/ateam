import { describe, expect, it } from "bun:test";
import type { PrStatus } from "@ateam/git-core";
import { preMergeGate } from "../src/merge-queue";

const pr = (over: Partial<PrStatus>): PrStatus => ({
	state: "OPEN",
	checks: "passing",
	mergeable: "MERGEABLE",
	isDraft: false,
	prNumber: 1,
	...over,
});

describe("preMergeGate — merge-time re-check of a possibly stale PR", () => {
	it("lets a green open PR through, verified or not", () => {
		expect(preMergeGate(pr({}), false).proceed).toBe(true);
		expect(preMergeGate(pr({}), true).proceed).toBe(true);
	});

	it("always blocks a draft — GitHub would reject it, then the loop would retry forever", () => {
		const v = preMergeGate(pr({ isDraft: true }), false);
		expect(v.proceed).toBe(false);
		if (!v.proceed) expect(v.message).toContain("draft");
	});

	it("always blocks a closed PR", () => {
		expect(preMergeGate(pr({ state: "CLOSED" }), false).proceed).toBe(false);
		expect(preMergeGate(pr({ state: "CLOSED" }), true).proceed).toBe(false);
	});

	it("lets MERGED through — mergeViaPR just syncs the board", () => {
		expect(preMergeGate(pr({ state: "MERGED" }), true).proceed).toBe(true);
	});

	it("lets NONE through — the button flow may be creating the first PR", () => {
		expect(
			preMergeGate(pr({ state: "NONE", checks: "none", prNumber: null }), false).proceed,
		).toBe(true);
	});

	it("verified jobs block when checks went red or pending while queued", () => {
		expect(preMergeGate(pr({ checks: "failing" }), true).proceed).toBe(false);
		expect(preMergeGate(pr({ checks: "pending" }), true).proceed).toBe(false);
	});

	it("verified jobs block on definitive CONFLICTING, but not transient UNKNOWN", () => {
		expect(preMergeGate(pr({ mergeable: "CONFLICTING" }), true).proceed).toBe(false);
		expect(preMergeGate(pr({ mergeable: "UNKNOWN" }), true).proceed).toBe(true);
	});

	it("manual merges keep their human-override semantics — red checks do not block", () => {
		expect(preMergeGate(pr({ checks: "failing" }), false).proceed).toBe(true);
		expect(preMergeGate(pr({ mergeable: "CONFLICTING" }), false).proceed).toBe(true);
	});
});
