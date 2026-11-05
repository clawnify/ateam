import { expect, test } from "bun:test";
import {
	bestMcShape,
	type McArea,
	type McShape,
	mcCapacity,
	mcShapeGrid,
	placeArrivals,
} from "./mc-layout";

// The grid on a 16-inch MacBook Pro (1728x1117 points) with the sidebar open,
// the same with the Lead open beside it, a 27-inch display, and a portrait one.
const LAPTOP: McArea = { width: 1488, height: 989 };
const LAPTOP_LEAD: McArea = { width: 1088, height: 989 };
const DISPLAY: McArea = { width: 2320, height: 1371 };
const PORTRAIT: McArea = { width: 840, height: 1800 };
const AREAS = [LAPTOP, LAPTOP_LEAD, DISPLAY, PORTRAIT, { width: 600, height: 400 }];

const rows = (...lines: number[]): McShape => ({ flow: "rows", lines });
const cols = (...lines: number[]): McShape => ({ flow: "cols", lines });

// How wide a shape's widest tile is, over its height.
const widest = (shape: McShape, area: McArea): number => {
	const k = shape.lines.length;
	return Math.max(
		...shape.lines.map((n) =>
			shape.flow === "rows"
				? area.width / n / (area.height / k)
				: area.width / k / (area.height / n),
		),
	);
};

test("two tiles stand side by side, still once the Lead narrows the grid", () => {
	expect(bestMcShape(1, LAPTOP)).toEqual(rows(1));
	expect(bestMcShape(2, LAPTOP)).toEqual(rows(2));
	// Not two wide strips, each twice as wide as it is tall.
	expect(bestMcShape(2, LAPTOP_LEAD)).toEqual(rows(2));
	// A portrait display stacks them: each is still taller than wide.
	expect(bestMcShape(2, PORTRAIT)).toEqual(rows(1, 1));
});

test("three tiles are three tall columns, not a main tile with two wide ones", () => {
	expect(bestMcShape(3, LAPTOP)).toEqual(rows(3));
	expect(bestMcShape(3, DISPLAY)).toEqual(rows(3));
});

test("four tiles on a laptop are two tall and two square, not a 2x2 of wide tiles", () => {
	// Four tall columns would be too narrow to read here.
	expect(bestMcShape(4, LAPTOP)).toEqual(cols(1, 1, 2));
	// A display has the width for four tall columns.
	expect(bestMcShape(4, DISPLAY)).toEqual(rows(4));
	// With the Lead open, nothing taller reads: the 2x2 is about square.
	expect(bestMcShape(4, LAPTOP_LEAD)).toEqual(rows(2, 2));
});

test("tall columns never drop below 60 columns: a full-height tile with two square ones instead", () => {
	// With the Lead open, three columns would be 46 wide: main + side, the
	// stacked two about square.
	expect(bestMcShape(3, LAPTOP_LEAD)).toEqual(cols(1, 2));
	// Four tall columns on a laptop would be 47 to 58 wide, however far the
	// sidebar narrows: two tall and two square instead.
	for (let width = 1488; width <= 1840; width += 8) {
		expect(bestMcShape(4, { width, height: 989 })).toEqual(cols(1, 1, 2));
	}
	// Four columns of 60 make it.
	expect(bestMcShape(4, { width: 1870, height: 989 })).toEqual(rows(4));
});

test("five tiles fill the page instead of leaving a slot of a 3x2 empty", () => {
	// A full-height tile with a 2x2 beside it.
	expect(bestMcShape(5, LAPTOP)).toEqual(cols(1, 2, 2));
	expect(bestMcShape(6, LAPTOP)).toEqual(rows(3, 3));
});

test("tiles lie down only when no other shape keeps every terminal readable", () => {
	// Every page Auto fills on a laptop, past a single tile, is square at worst,
	// and on a display up to eight tiles.
	for (const [area, upTo] of [
		[LAPTOP, mcCapacity(LAPTOP)],
		[LAPTOP_LEAD, mcCapacity(LAPTOP_LEAD)],
		[DISPLAY, 8],
	] as const) {
		for (let n = 2; n <= upTo; n++) {
			expect(widest(bestMcShape(n, area), area)).toBeLessThanOrEqual(1.2);
		}
	}
	// Nine on a display would be five columns of 59: one wide row of tiles.
	expect(bestMcShape(9, DISPLAY)).toEqual(cols(2, 2, 2, 3));
	// A portrait display is too narrow for two columns of 60: it stacks.
	expect(bestMcShape(3, PORTRAIT)).toEqual(rows(1, 1, 1));
	const narrow = { width: 440, height: 720 };
	expect(bestMcShape(2, narrow)).toEqual(rows(1, 1));
});

test("no laptop column stacks three tiles: a 2x2 instead, the rest on the next page", () => {
	// The grid beside an open Lead held a page of five as a column of two and a
	// column of three, 17 lines each, about five rows of output under the
	// agent's own chrome.
	const besideLead = { width: 1000, height: 997 };
	expect(mcCapacity(besideLead, 5)).toBe(4);
	expect(bestMcShape(4, besideLead)).toEqual(rows(2, 2));
	// A little taller, the same strips made a page of six fresh.
	expect(mcCapacity({ width: 1000, height: 1030 })).toBe(4);
	// Opening the Lead on a laptop's 3x2 re-pages it to a 2x2, not three rows
	// of two wide strips.
	expect(mcCapacity(LAPTOP_LEAD, 6)).toBe(4);
	// A 13-inch laptop still gets two rows (21 lines each).
	expect(mcCapacity({ width: 1200, height: 772 })).toBe(4);
});

test("every tile gets a cell and every cell a tile", () => {
	for (const area of AREAS) {
		for (let n = 1; n <= 30; n++) {
			const shape = bestMcShape(n, area);
			expect(shape.lines.reduce((a, b) => a + b, 0)).toBe(n);
			// Lines deal the tiles evenly, fewer first.
			const [first, last] = [shape.lines[0], shape.lines[shape.lines.length - 1]];
			expect(last - first).toBeLessThanOrEqual(1);
			expect([...shape.lines].sort((a, b) => a - b)).toEqual(shape.lines);
		}
	}
	expect(bestMcShape(0, LAPTOP).lines).toEqual([]);
});

test("a page holds more tiles on a bigger grid, and always at least one", () => {
	expect(mcCapacity(LAPTOP)).toBe(6);
	expect(mcCapacity(LAPTOP_LEAD)).toBe(4);
	expect(mcCapacity(DISPLAY)).toBeGreaterThan(mcCapacity(LAPTOP));
	expect(mcCapacity({ width: 200, height: 150 })).toBe(1);
});

test("a resize keeps the page size until the space moves past the margin", () => {
	// Narrowing the grid squeezes a 3x2 to 58 columns, inside the margin: the
	// page holds. Fitted fresh at that size, a page would take four.
	const squeezed = { width: 1350, height: 989 };
	expect(mcCapacity(squeezed)).toBe(4);
	expect(mcCapacity(squeezed, 6)).toBe(6);
	// More room grows the page, pulling tiles back from the next one.
	expect(mcCapacity(LAPTOP, 4)).toBe(6);
	// A real squeeze re-pages.
	expect(mcCapacity({ width: 500, height: 600 }, 6)).toBeLessThan(6);
});

test("the grid gives each line's tiles an equal share of its tracks", () => {
	const mainSide = mcShapeGrid(cols(1, 2));
	expect(mainSide.container).toEqual({
		gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
		gridTemplateRows: "repeat(2, minmax(0, 1fr))",
		gridAutoFlow: "column",
	});
	expect(mainSide.tiles).toEqual([
		{ gridRow: "span 2" },
		{ gridRow: "span 1" },
		{ gridRow: "span 1" },
	]);

	const twoThree = mcShapeGrid(rows(2, 3));
	expect(twoThree.container.gridTemplateColumns).toBe("repeat(6, minmax(0, 1fr))");
	expect(twoThree.container.gridTemplateRows).toBe("repeat(2, minmax(0, 1fr))");
	expect(twoThree.tiles.map((t) => ("gridColumn" in t ? t.gridColumn : ""))).toEqual([
		"span 3",
		"span 3",
		"span 2",
		"span 2",
		"span 2",
	]);
});

test("a tile woken by a drop takes the slot it was dropped on, and the rest move along one", () => {
	const id = (s: string) => s;
	const onB = new Map([["x", "b"]]);
	expect(placeArrivals(["a", "b", "c"], ["x"], id, onB)).toEqual(["a", "x", "b", "c"]);
	expect(placeArrivals(["a", "b"], ["x"], id, new Map([["x", "a"]]))).toEqual(["x", "a", "b"]);
});

test("an arrival with no spot, dropped off the tiles, or whose tile is gone goes last", () => {
	const id = (s: string) => s;
	expect(placeArrivals(["a", "b"], ["x"], id, new Map())).toEqual(["a", "b", "x"]);
	expect(placeArrivals(["a", "b"], ["x"], id, new Map([["x", null]]))).toEqual(["a", "b", "x"]);
	expect(placeArrivals(["a", "b"], ["x"], id, new Map([["x", "gone"]]))).toEqual(["a", "b", "x"]);
});

test("arrivals together keep their order: two dropped on one tile, and one with no spot", () => {
	const id = (s: string) => s;
	const place = new Map([
		["x", "b"],
		["y", "b"],
	]);
	expect(placeArrivals(["a", "b"], ["x", "y", "z"], id, place)).toEqual(["a", "x", "y", "b", "z"]);
	expect(placeArrivals<string>([], ["x"], id, place)).toEqual(["x"]);
});
