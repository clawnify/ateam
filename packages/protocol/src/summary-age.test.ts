import { expect, test } from "bun:test";
import { staleSummaryAt } from "./summary-age";

const WRITTEN = 1_700_000_000_000;
const MINUTE = 60_000;
const task = (over: object = {}) => ({
	summary: "Task is in Review.",
	summaryAsOf: WRITTEN,
	lastEventAt: WRITTEN,
	...over,
});

test("a summary that read the latest activity is current", () => {
	expect(staleSummaryAt(task())).toBeNull();
});

test("activity after the summary makes it stale, as of when it was written", () => {
	expect(staleSummaryAt(task({ lastEventAt: WRITTEN + 41 * MINUTE }))).toBe(WRITTEN);
});

test("an engine that doesn't say when it was written never reads stale", () => {
	expect(
		staleSummaryAt(task({ summaryAsOf: undefined, lastEventAt: WRITTEN + MINUTE })),
	).toBeNull();
	expect(staleSummaryAt(task({ summary: null, lastEventAt: WRITTEN + MINUTE }))).toBeNull();
});
