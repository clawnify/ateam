import { beforeEach, expect, test } from "bun:test";
import { bumpProject, orderProjects, readProjectOrder, saveProjectOrder } from "./project-order";

const store = new Map<string, string>();
globalThis.localStorage = {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
	clear: () => store.clear(),
	key: () => null,
	length: 0,
} as Storage;

beforeEach(() => store.clear());

const BOARD = ["a", "b", "c", "d", "e"];
const shown = (order: string[], keys = BOARD) =>
	orderProjects(
		keys.map((key) => ({ key })),
		order,
	).map((c) => c.key);

test("nothing switched to yet: the board's own order", () => {
	expect(shown([])).toEqual(BOARD);
});

test("a project from below the top three moves to the top, the rest shift down", () => {
	const order = bumpProject([], BOARD, "e");
	expect(shown(order)).toEqual(["e", "a", "b", "c", "d"]);
	expect(shown(bumpProject(order, BOARD, "c"))).toEqual(["c", "e", "a", "b", "d"]);
});

test("switching between the top three leaves the order as it is", () => {
	let order = bumpProject([], BOARD, "d");
	const before = shown(order);
	for (const key of ["b", "d", "a", "b"]) {
		const next = bumpProject(order, BOARD, key);
		// The same array, so the switcher doesn't re-render or rewrite storage.
		expect(next).toBe(order);
		order = next;
	}
	expect(shown(order)).toEqual(before);
});

test("a project never switched to (just added) lands at the bottom, then the top once opened", () => {
	const order = bumpProject([], BOARD, "c");
	const board = [...BOARD, "new"];
	expect(shown(order, board).at(-1)).toBe("new");
	expect(shown(bumpProject(order, board, "new"), board)[0]).toBe("new");
});

test("an away box's projects keep their place for when it is back", () => {
	let order = bumpProject([], BOARD, "e");
	order = bumpProject(order, BOARD, "d"); // d e a b c
	const away = BOARD.filter((k) => k !== "e");
	expect(shown(order, away)).toEqual(["d", "a", "b", "c"]);
	// c moves up while e is away; e is still remembered behind it.
	order = bumpProject(order, away, "c");
	expect(shown(order, away)).toEqual(["c", "d", "a", "b"]);
	expect(shown(order)).toEqual(["c", "d", "a", "b", "e"]);
});

test("a card that isn't on the board changes nothing", () => {
	const order = ["a"];
	expect(bumpProject(order, BOARD, "gone")).toBe(order);
});

test("the order survives a restart, and bad storage reads as none", () => {
	saveProjectOrder(["gh:o/x", "engine:local:p1"]);
	expect(readProjectOrder()).toEqual(["gh:o/x", "engine:local:p1"]);
	store.set("ateam.projectOrder", "{not json");
	expect(readProjectOrder()).toEqual([]);
	store.set("ateam.projectOrder", JSON.stringify(["a", 3, null]));
	expect(readProjectOrder()).toEqual(["a"]);
});
