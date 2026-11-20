import { expect, test } from "bun:test";
import { staleSummaryNote } from "./summary";

const WRITTEN = new Date(2026, 10, 9, 19, 2).getTime();
const MINUTE = 60_000;

test("the note names the time, and the day once it isn't today", () => {
	const time = new Date(WRITTEN).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	expect(staleSummaryNote(WRITTEN, WRITTEN + 41 * MINUTE)).toBe(
		`Written at ${time}, before the latest turn`,
	);
	const nextDay = staleSummaryNote(WRITTEN, WRITTEN + 24 * 60 * MINUTE);
	expect(nextDay).toStartWith("Written ");
	expect(nextDay).toContain(` at ${time}, before the latest turn`);
	expect(nextDay).not.toBe(`Written at ${time}, before the latest turn`);
});
