import { expect, test } from "bun:test";
import { landingAfter } from "./cleanup-select";

const ROWS = ["a", "b", "c", "d"];

test("lands on the next row down", () => {
	expect(landingAfter(ROWS, "b", new Set(["b"]))).toBe("c");
});

test("the last row falls back to the one above", () => {
	expect(landingAfter(ROWS, "d", new Set(["d"]))).toBe("c");
});

test("the only row leaves nothing to land on", () => {
	expect(landingAfter(["a"], "a", new Set(["a"]))).toBeNull();
});

test("skips rows that are leaving too (a bulk delete)", () => {
	expect(landingAfter(ROWS, "a", new Set(["a", "b", "c"]))).toBe("d");
	expect(landingAfter(ROWS, "c", new Set(["b", "c", "d"]))).toBe("a");
});

test("a row not on screen lands on the first that stays", () => {
	expect(landingAfter(ROWS, "zz", new Set(["zz", "a"]))).toBe("b");
});
