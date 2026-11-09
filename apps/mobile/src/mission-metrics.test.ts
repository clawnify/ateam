import { expect, test } from "bun:test";
import { bestMcShape, mcCapacity, mcShapeRects } from "../../../packages/panes/src/mc-layout";
import { MC_NATIVE_METRICS as metrics } from "./mission-metrics";

test("native Auto matches measured iPad cells with expanded and collapsed sidebar", () => {
	for (const [width, cols] of [
		[1096, 68],
		[1320, 82],
	]) {
		const area = { width, height: 800 };
		const capacity = mcCapacity(area, undefined, metrics);
		expect(capacity).toBe(4);
		for (const frame of mcShapeRects(bestMcShape(capacity, area, metrics), area)) {
			expect(Math.floor((frame.width - metrics.chromeWidth) / metrics.cellWidth)).toBe(cols);
			// The simulator reports 21 lines with a session row, 24 without it.
			expect(Math.floor((frame.height - metrics.chromeHeight) / metrics.cellHeight)).toBe(21);
			expect(Math.floor((frame.height - 32) / metrics.cellHeight)).toBe(24);
		}
	}
});

test("native capacity uses its own 60-column and 20-line floors", () => {
	expect(mcCapacity({ width: 940, height: 800 })).toBe(4); // desktop defaults
	expect(mcCapacity({ width: 940, height: 800 }, undefined, metrics)).toBe(2);
	expect(mcCapacity({ width: 964, height: 752 }, undefined, metrics)).toBe(4);
	expect(mcCapacity({ width: 963, height: 752 }, undefined, metrics)).toBe(2);
	expect(mcCapacity({ width: 964, height: 751 }, undefined, metrics)).toBe(2);
	for (const width of [744, 752, 890]) {
		const area = { width, height: 800 };
		const capacity = mcCapacity(area, undefined, metrics);
		expect(capacity).toBe(2);
		expect(bestMcShape(capacity, area, metrics)).toEqual({ flow: "rows", lines: [1, 1] });
	}
	// A compact window too narrow for 60 columns still shows one terminal.
	expect(mcCapacity({ width: 403, height: 800 }, undefined, metrics)).toBe(1);
});

test("native resize hysteresis uses native metrics for both shrink and grow", () => {
	expect(mcCapacity({ width: 964, height: 800 }, 2, metrics)).toBe(2);
	expect(mcCapacity({ width: 1012, height: 800 }, 2, metrics)).toBe(4);
	expect(mcCapacity({ width: 964, height: 800 }, 4, metrics)).toBe(4);
	expect(mcCapacity({ width: 915, height: 800 }, 4, metrics)).toBe(2);
});
