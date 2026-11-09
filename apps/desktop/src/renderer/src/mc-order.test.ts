import { expect, test } from "bun:test";
import type { TaskDTO } from "@ateam/protocol";
import {
	holdMcTile,
	orderMcTiles,
	pinMcArrival,
	pinMcSwap,
	readMcPins,
	stabilizeMcPages,
	undoMcPins,
} from "./mc-order";

function tile(
	id: string,
	lastEventAt: number | null,
	column: TaskDTO["column"] = "running",
	agentStatus: TaskDTO["agentStatus"] = "running",
) {
	return { task: { id, lastEventAt, column, agentStatus } };
}
const ids = (tiles: ReturnType<typeof tile>[]) => tiles.map((t) => t.task.id);

test("Needs You precedes recent activity, with newest first in each band", () => {
	const tiles = [
		tile("running", 100),
		tile("needs", 5, "needs_attention"),
		tile("asking", 10, "running", "awaiting_input"),
		tile("older", 50),
		tile("missing", null),
	];
	expect(ids(orderMcTiles(tiles, {}))).toEqual(["asking", "needs", "running", "older", "missing"]);
	expect(ids(tiles)).toEqual(["running", "needs", "asking", "older", "missing"]);
});

test("new activity and a status change reorder existing tiles without a session fetch", () => {
	const tiles = [tile("a", 10), tile("b", 20), tile("c", 30)];
	expect(ids(orderMcTiles(tiles, {}))).toEqual(["c", "b", "a"]);
	const updated = tiles.map((t) => (t.task.id === "a" ? tile("a", 40) : t));
	expect(ids(orderMcTiles(updated, {}))).toEqual(["a", "c", "b"]);
	expect(
		ids(orderMcTiles([tile("a", 40), tile("b", 20, "needs_attention"), tile("c", 30)], {})),
	).toEqual(["b", "a", "c"]);
});

test("ties retain their base order", () => {
	expect(ids(orderMcTiles([tile("b", 10), tile("a", 10), tile("c", null)], {}))).toEqual([
		"b",
		"a",
		"c",
	]);
});

test("a settled priority snapshot holds activity changes while pins remain immediate", () => {
	const tiles = [tile("a", 10), tile("b", 20), tile("c", 100, "needs_attention")];
	const rank = new Map([
		["a", 0],
		["b", 1],
		["c", 2],
	]);
	expect(ids(orderMcTiles(tiles, {}, rank))).toEqual(["a", "b", "c"]);
	expect(ids(orderMcTiles(tiles, { c: 0 }, rank))).toEqual(["c", "a", "b"]);
	expect(ids(orderMcTiles([...tiles, tile("new", 200)], {}, rank))).toEqual(["a", "b", "c", "new"]);
});

test("a dragged tile stays in its slot while Needs You fills the first free slot", () => {
	const tiles = [tile("a", 30), tile("b", 20), tile("c", 10)];
	const pins = pinMcSwap({}, ids(tiles), "c", "a");
	expect(pins).toEqual({ c: 0 });
	expect(
		ids(
			orderMcTiles(
				[tile("b", 50, "needs_attention"), ...tiles.filter((t) => t.task.id !== "b")],
				pins,
			),
		),
	).toEqual(["c", "b", "a"]);
	expect(ids(orderMcTiles(tiles, {}))).toEqual(["a", "b", "c"]); // Refresh clears pins.
});

test("multiple pins stay put across pages and a new terminal fills a free slot", () => {
	const tiles = Array.from({ length: 12 }, (_, i) => tile(String(i), i));
	const pins = { "0": 1, "1": 7, "2": 10 };
	const ordered = orderMcTiles([...tiles, tile("new", 100, "needs_attention")], pins);
	expect(ordered[1]?.task.id).toBe("0");
	expect(ordered[7]?.task.id).toBe("1");
	expect(ordered[10]?.task.id).toBe("2");
	expect(ordered[0]?.task.id).toBe("new");
});

test("a pinned destination trades slots, while every other pin is retained", () => {
	const pins = { a: 0, b: 1, c: 2 };
	expect(pinMcSwap(pins, ["a", "b", "c", "d"], "d", "b")).toEqual({ a: 0, b: 3, c: 2, d: 1 });
	expect(pinMcSwap(pins, ["a", "b", "c"], "a", "b")).toEqual({ a: 1, b: 0, c: 2 });
	expect(pinMcSwap(pins, ["a", "b"], "a", "a")).toBe(pins);
	expect(pinMcSwap(pins, ["a", "b"], "gone", "a")).toBe(pins);
});

test("shrinking and regrowing a grid keeps every tile once and restores saved pin slots", () => {
	const pins = { b: 2, c: 5 };
	const small = [tile("a", 100), tile("b", 20), tile("c", 30)];
	expect(ids(orderMcTiles(small, pins))).toEqual(["a", "b", "c"]);
	const large = [...small, tile("d", 40), tile("e", 50), tile("f", 60)];
	const ordered = ids(orderMcTiles(large, pins));
	expect(ordered[2]).toBe("b");
	expect(ordered[5]).toBe("c");
	expect(new Set(ordered).size).toBe(6);
	expect(ids(orderMcTiles([tile("a", 100)], pins))).toEqual(["a"]);
});

test("a waking task reserves a drop slot, displacing only a pinned target", () => {
	const pins = { b: 1, c: 2 };
	const next = pinMcArrival(pins, ["a", "b", "c"], "new", "b");
	expect(next).toEqual({ b: 3, c: 2, new: 1 });
	expect(
		ids(orderMcTiles([tile("a", 100), tile("b", 20), tile("c", 30), tile("new", 0)], next)),
	).toEqual(["a", "new", "c", "b"]);
	expect(pinMcArrival({}, ["a", "b"], "new", null)).toEqual({ new: 2 });
	expect(pinMcArrival({}, ["a", "b"], "new", "gone")).toEqual({ new: 2 });
});

test("pin storage rejects malformed values and separates grids", () => {
	const stored = new Map<string, string>([
		["project:tasks", JSON.stringify({ a: 2, bad: -1, fraction: 1.5, text: "2" })],
		["project:loops", JSON.stringify({ loop: 0 })],
		["broken", "{"],
		["array", "[1,2]"],
	]);
	const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: (key: string) => stored.get(key) ?? null },
	});
	try {
		expect(readMcPins("project:tasks")).toEqual({ a: 2 });
		expect(readMcPins("project:loops")).toEqual({ loop: 0 });
		expect(readMcPins("broken")).toEqual({});
		expect(readMcPins("array")).toEqual({});
		expect(readMcPins("absent")).toEqual({});
	} finally {
		if (previous) Object.defineProperty(globalThis, "localStorage", previous);
		else Reflect.deleteProperty(globalThis, "localStorage");
	}
});

test("a failed wake restores displaced pins without undoing later drags", () => {
	const before = { b: 1, c: 2 };
	const after = pinMcArrival(before, ["a", "b", "c"], "new", "b");
	expect(undoMcPins(after, before, after)).toEqual(before);
	expect(undoMcPins({ ...after, b: 0, other: 4 }, before, after)).toEqual({ b: 0, c: 2, other: 4 });
	const again = pinMcArrival(after, ["a", "b", "c"], "new", "c");
	expect(undoMcPins(undoMcPins(again, after, again), before, after)).toEqual(before);
});

test("activity permutations within a page leave every terminal in its slot", () => {
	expect(stabilizeMcPages(["c", "a", "b"], ["a", "b", "c"], 3)).toEqual(["a", "b", "c"]);
	expect(stabilizeMcPages(["b", "a", "d", "c"], ["a", "b", "c", "d"], 2)).toEqual([
		"a",
		"b",
		"c",
		"d",
	]);
});

test("an incoming terminal replaces the outgoing one without shuffling shared terminals", () => {
	expect(
		stabilizeMcPages(["e", "a", "c", "b", "d", "f"], ["a", "b", "c", "d", "e", "f"], 3),
	).toEqual(["a", "e", "c", "d", "b", "f"]);
	expect(
		stabilizeMcPages(["e", "f", "a", "b", "c", "d"], ["a", "b", "c", "d", "e", "f"], 3),
	).toEqual(["a", "e", "f", "d", "b", "c"]);
});

test("page stabilization keeps pinned slots and handles a partial last page", () => {
	expect(
		stabilizeMcPages(["c", "b", "f", "a", "e", "d"], ["a", "b", "c", "d", "e", "f"], 3),
	).toEqual(["f", "b", "c", "d", "e", "a"]);
	expect(
		stabilizeMcPages(["a", "b", "c", "e", "f", "g", "d"], ["a", "b", "c", "d", "e", "f", "g"], 3),
	).toEqual(["a", "b", "c", "g", "e", "f", "d"]);
});

test("the selected tile on the page in view keeps its slot when its activity would move it", () => {
	// Page 2 (slots 3 to 5) is in view and f is selected. f turning newest would
	// send it to page 1; held, it stays, and page 1 keeps its tiles.
	const tiles = [
		tile("a", 60),
		tile("b", 50),
		tile("c", 40),
		tile("d", 30),
		tile("e", 20),
		tile("f", 900),
	];
	const current = ids(tiles);
	const held = holdMcTile({}, current, "f", 1, 3);
	expect(held).toEqual({ f: 5 });
	const next = ids(orderMcTiles(tiles, held));
	expect(stabilizeMcPages(next, current, 3)).toEqual(current);
	// Not selected, f goes to page 1 and the lowest there (c) makes room.
	expect(stabilizeMcPages(ids(orderMcTiles(tiles, {})), current, 3)).toEqual([
		"a",
		"b",
		"f",
		"d",
		"e",
		"c",
	]);
});

test("a selected tile off the page in view, already pinned, or gone is not held", () => {
	const current = ["a", "b", "c", "d"];
	// On page 2 while page 1 is in view: free to come to page 1.
	expect(holdMcTile({}, current, "d", 0, 2)).toEqual({});
	expect(holdMcTile({ b: 1 }, current, "b", 0, 2)).toEqual({ b: 1 });
	// A pin already claims that slot: the pin wins.
	expect(holdMcTile({ c: 0 }, current, "a", 0, 2)).toEqual({ c: 0 });
	expect(holdMcTile({}, current, "z", 0, 2)).toEqual({});
	expect(holdMcTile({}, current, null, 0, 2)).toEqual({});
});
