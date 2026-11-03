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

test("two tiles sit side by side on a wide grid and stack once the Lead narrows it", () => {
	expect(bestMcShape(1, LAPTOP)).toEqual(rows(1));
	expect(bestMcShape(2, LAPTOP)).toEqual(rows(2));
	expect(bestMcShape(2, LAPTOP_LEAD)).toEqual(rows(1, 1));
	expect(bestMcShape(2, PORTRAIT)).toEqual(rows(1, 1));
});

test("three tiles are main + side: the spare room lands as height", () => {
	expect(bestMcShape(3, LAPTOP)).toEqual(cols(1, 2));
});

test("five tiles fill the page instead of leaving a slot of a 3x2 empty", () => {
	// A full-height tile with a 2x2 beside it.
	expect(bestMcShape(5, LAPTOP)).toEqual(cols(1, 2, 2));
});

test("four and six tiles are the 2x2 and the 3x2", () => {
	expect(bestMcShape(4, LAPTOP)).toEqual(rows(2, 2));
	expect(bestMcShape(6, LAPTOP)).toEqual(rows(3, 3));
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
	// Opening the Lead squeezes a 3x2, but not past the margin: the page
	// holds. Fitted fresh at that size, a page would take four.
	expect(mcCapacity(LAPTOP_LEAD, 6)).toBe(6);
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
