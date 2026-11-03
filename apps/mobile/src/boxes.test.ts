// The connection screen's list of boxes: one per address, newest first, and what each card says.
import { describe, expect, test } from "bun:test";
import {
	awayOf,
	boxKey,
	boxSubtitle,
	boxTitle,
	leadBoxOf,
	leadFirst,
	NEW_LINK,
	parseBoxes,
	pickRunOn,
	removeBox,
	type SavedBox,
	touchBox,
} from "./boxes";

const probe: SavedBox = {
	host: "100.81.40.73",
	port: "8787",
	provider: { id: "boxd", box: { machine: "ateam-probe" } },
	lastUsedAt: 1,
};
const sprite: SavedBox = {
	host: "100.94.46.10",
	port: "8787",
	provider: { id: "sprites", box: { machine: "ateam-box" } },
	lastUsedAt: 2,
};
const plain: SavedBox = { host: "100.103.43.43", port: "8787", lastUsedAt: 3 };

describe("boxes", () => {
	test("an address is one box, whatever the host's case or a blank port", () => {
		expect(boxKey({ host: " Box.TAIL.ts.net ", port: "" })).toBe("box.tail.ts.net:8787");
		expect(boxKey(probe)).toBe(boxKey({ host: "100.81.40.73", port: " 8787" }));
	});

	test("connecting moves a box to the top without duplicating it", () => {
		const list = touchBox([sprite, probe, plain], { host: "100.81.40.73", port: "8787" }, 9);
		expect(list.map(boxKey)).toEqual([boxKey(probe), boxKey(sprite), boxKey(plain)]);
		expect(list[0]?.lastUsedAt).toBe(9);
		// The connection that was just made is what's kept, so a provider removed in the form is gone.
		expect(list[0]?.provider).toBeUndefined();
	});

	test("a new box joins at the top", () => {
		const list = touchBox([probe], { host: "100.64.0.9", port: "8787" }, 5);
		expect(list.map((b) => b.host)).toEqual(["100.64.0.9", "100.81.40.73"]);
	});

	test("an edit that changes the address replaces the box it was edited from", () => {
		const list = touchBox([sprite, probe], { ...probe, port: "9000" }, 7, boxKey(probe));
		expect(list.map(boxKey)).toEqual(["100.81.40.73:9000", boxKey(sprite)]);
	});

	test("removing a box leaves the others in order", () => {
		expect(removeBox([sprite, probe, plain], boxKey(probe)).map(boxKey)).toEqual([
			boxKey(sprite),
			boxKey(plain),
		]);
	});

	test("a card is titled by the box's name at its provider, else its host", () => {
		expect(boxTitle(probe)).toBe("ateam-probe");
		expect(boxSubtitle(probe)).toBe("100.81.40.73:8787 · boxd");
		expect(boxSubtitle(sprite)).toBe("100.94.46.10:8787 · Sprites");
		expect(boxTitle(plain)).toBe("100.103.43.43");
		expect(boxSubtitle(plain)).toBe("port 8787");
		// A provider picked with its name left blank falls back to the host.
		const unnamed = {
			host: "100.64.0.9",
			port: "8787",
			provider: { id: "boxd", box: { machine: " " } },
		};
		expect(boxTitle(unnamed)).toBe("100.64.0.9");
		expect(boxSubtitle(unnamed)).toBe("port 8787 · boxd");
	});

	test("the stored list loads, and a single remembered connection becomes the first box", () => {
		expect(parseBoxes(JSON.stringify([sprite, probe]), null)).toEqual([sprite, probe]);
		const last = { host: "100.81.40.73", port: "8787", provider: probe.provider };
		expect(parseBoxes(null, JSON.stringify(last))).toEqual([{ ...last, lastUsedAt: 0 }]);
		// Once a list exists it wins, even an empty one: deleting every box must stick.
		expect(parseBoxes("[]", JSON.stringify(last))).toEqual([]);
	});

	test("anything that doesn't parse as a box is dropped, never thrown", () => {
		expect(parseBoxes("{not json", null)).toEqual([]);
		expect(parseBoxes(JSON.stringify([{ host: "" }, 4, null, plain]), null)).toEqual([plain]);
		expect(parseBoxes(null, JSON.stringify({ port: "8787" }))).toEqual([]);
	});
});

describe("which box", () => {
	test("the Lead is the picked box while it's on the list, else the one used last", () => {
		expect(leadBoxOf([probe, sprite], boxKey(sprite))).toBe(boxKey(sprite));
		expect(leadBoxOf([probe, sprite], "gone:8787")).toBe(boxKey(probe));
		expect(leadBoxOf([probe], null)).toBe(boxKey(probe));
		expect(leadBoxOf([], null)).toBeNull();
	});

	test("a task runs on the picked box, else the Lead's box, else the first that answers", () => {
		const on = [boxKey(probe), boxKey(sprite)];
		const live = (k: string) => k === boxKey(sprite);
		expect(pickRunOn(on, boxKey(probe), null, live)).toBe(boxKey(probe));
		// Nothing picked for this project: the Lead's box, up or not, as Local on the desktop.
		expect(pickRunOn(on, null, boxKey(probe), live)).toBe(boxKey(probe));
		expect(pickRunOn(on, boxKey(plain), boxKey(probe), live)).toBe(boxKey(probe));
		// The Lead's box hasn't got the project: the first one up.
		expect(pickRunOn(on, boxKey(plain), boxKey(plain), live)).toBe(boxKey(sprite));
		// None up: the first, which the start then wakes.
		expect(pickRunOn(on, null, null, () => false)).toBe(boxKey(probe));
		expect(pickRunOn([], null, null, live)).toBeNull();
	});

	test("the Lead's box leads a list of boxes", () => {
		expect(leadFirst(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
		expect(leadFirst(["a", "b"], "z")).toEqual(["a", "b"]);
		expect(leadFirst(["a", "b"], null)).toEqual(["a", "b"]);
	});

	test("a box is away while it sleeps or after a failure, not while it's up or untried", () => {
		expect(awayOf(undefined)).toBeNull();
		expect(awayOf({ ...NEW_LINK, state: "live", error: "old" })).toBeNull();
		expect(awayOf({ ...NEW_LINK, state: "connecting" })).toBeNull();
		expect(awayOf({ ...NEW_LINK, state: "connecting", asleep: true })).toBe("asleep");
		expect(awayOf({ ...NEW_LINK, state: "down", error: "timed out" })).toBe("offline");
		// Tried again: still away until the try says otherwise.
		expect(awayOf({ ...NEW_LINK, state: "connecting", error: "timed out" })).toBe("offline");
	});
});
