// The connection screen's list of boxes: one per address, newest first, and what each card says.
import { describe, expect, test } from "bun:test";
import { NEEDS_PAIRING } from "@ateam/protocol";
import {
	alwaysOnInForm,
	awayOf,
	type BoxLink,
	boxKey,
	boxSubtitle,
	boxTitle,
	CONNECTION_LOST,
	cantWakeReason,
	leadBoxOf,
	leadFirst,
	NEW_LINK,
	needsProvider,
	parseBoxes,
	pickRunOn,
	removeBox,
	type SavedBox,
	shownAsleep,
	touchBox,
	wakesThrough,
	withReportedProvider,
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

	test("a box saved by its address alone takes the provider it reports, in place", () => {
		const bare: SavedBox = { host: "100.94.46.10", port: "8787", lastUsedAt: 2 };
		const reported = { id: "sprites", box: { machine: "ateam-box" }, sleeps: true };
		const next = withReportedProvider([probe, bare, plain], boxKey(bare), reported);
		expect(next).toEqual([
			probe,
			{ ...bare, provider: { id: "sprites", box: { machine: "ateam-box" } }, sleeps: true },
			plain,
		]);
		// Then its card is titled and woken as the Sprite it is.
		expect(next && boxTitle(next[1] as SavedBox)).toBe("ateam-box");
	});

	test("a box on exe.dev says so, and is named for it without anything to wake", () => {
		const reported = { id: "exe", box: {}, sleeps: false };
		const next = withReportedProvider([plain], boxKey(plain), reported);
		const exe = next?.[0] as SavedBox;
		expect(exe).toEqual({ ...plain, provider: { id: "exe", box: {} }, sleeps: false });
		expect(boxSubtitle(exe)).toBe("port 8787 · exe.dev");
		expect(boxTitle(exe)).toBe(plain.host);
		// Nothing to wake, even before it had said it's always on.
		const failed: BoxLink = { ...NEW_LINK, state: "down", error: "Timed out reaching the box" };
		for (const box of [exe, { ...exe, sleeps: undefined }]) {
			expect(wakesThrough(box)).toBeUndefined();
			expect(cantWakeReason(box)).toBeNull();
			expect(needsProvider(box, failed)).toBe(false);
		}
	});

	test("a provider the user picked stays; only its blank name is filled", () => {
		const reported = { id: "sprites", box: { machine: "other-name" }, sleeps: true };
		const known: SavedBox = { ...sprite, sleeps: true };
		expect(withReportedProvider([known], boxKey(known), reported)).toBeNull();
		// A different provider than the box reports: the user's choice stands.
		expect(withReportedProvider([{ ...probe, sleeps: true }], boxKey(probe), reported)).toBeNull();
		const unnamed: SavedBox = { ...known, provider: { id: "sprites", box: { machine: " " } } };
		expect(withReportedProvider([unnamed], boxKey(unnamed), reported)).toEqual([
			{ ...unnamed, provider: { id: "sprites", box: { machine: "other-name" } } },
		]);
	});

	test("whether a box sleeps follows its latest report, even under a provider the user picked", () => {
		const report = (sleeps: boolean) => ({ id: "sprites", box: { machine: "ateam-box" }, sleeps });
		const always = withReportedProvider([sprite], boxKey(sprite), report(false));
		expect(always).toEqual([{ ...sprite, sleeps: false }]);
		// Idle sleep turned back on: the next connect says so.
		const again = always && withReportedProvider(always, boxKey(sprite), report(true));
		expect(again).toEqual([{ ...sprite, sleeps: true }]);
	});

	test("the form starts a new box always on, and a saved one as it last said", () => {
		expect(alwaysOnInForm(null)).toBe(true);
		expect(alwaysOnInForm({ ...sprite, sleeps: false })).toBe(true);
		expect(alwaysOnInForm({ ...sprite, sleeps: true })).toBe(false);
		// Never said (an older engine): as it was, sleeping.
		expect(alwaysOnInForm(sprite)).toBe(false);
	});

	test("a box that says it's always on is never shown asleep or asked about", () => {
		const always: SavedBox = { ...sprite, sleeps: false };
		expect(wakesThrough(always)).toBeUndefined();
		expect(cantWakeReason(always)).toBeNull();
		expect(wakesThrough(sprite)?.id).toBe("sprites");
		// Not answering, with no provider either: still nothing to wake.
		const failed: BoxLink = { ...NEW_LINK, state: "down", error: "Timed out reaching the box" };
		expect(needsProvider({ ...plain, sleeps: false }, failed)).toBe(false);
		expect(needsProvider(plain, failed)).toBe(true);
	});

	test("a box that no provider puts to sleep is always on, and never asked for one", () => {
		const next = withReportedProvider([sprite, plain], boxKey(plain), null);
		expect(next).toEqual([sprite, { ...plain, sleeps: false }]);
		const failed: BoxLink = { ...NEW_LINK, state: "down", error: "Timed out reaching the box" };
		expect(needsProvider(next?.[1] as SavedBox, failed)).toBe(false);
		// Said already: nothing to change.
		expect(withReportedProvider([{ ...plain, sleeps: false }], boxKey(plain), null)).toBeNull();
		// One given a provider keeps it and whether it sleeps: a tap still wakes it through it.
		expect(withReportedProvider([sprite], boxKey(sprite), null)).toBeNull();
		expect(withReportedProvider([plain], "100.1.1.1:8787", null)).toBeNull();
	});

	test("nothing reported, nothing wakeable, or a box off the list changes nothing", () => {
		const x = { id: "sprites", box: { machine: "x" }, sleeps: true };
		expect(withReportedProvider([plain], boxKey(plain), undefined)).toBeNull();
		expect(withReportedProvider([plain], boxKey(plain), { ...x, id: "nope" })).toBeNull();
		expect(withReportedProvider([plain], boxKey(plain), { ...x, box: {} })).toBeNull();
		expect(withReportedProvider([plain], "100.1.1.1:8787", x)).toBeNull();
	});

	test("a box with no provider that isn't answering needs one, through the tries after", () => {
		const failed: BoxLink = { ...NEW_LINK, state: "down", error: "Timed out reaching the box" };
		expect(needsProvider(plain, failed)).toBe(true);
		// Tried again: the last failure is kept, so the hint stays put.
		expect(needsProvider(plain, { ...failed, state: "connecting" })).toBe(true);
		// Up, untried, locked (it answered), or just dropped (reconnecting): no hint.
		expect(needsProvider(plain, { ...failed, state: "live", error: null })).toBe(false);
		expect(needsProvider(plain, NEW_LINK)).toBe(false);
		expect(needsProvider(plain, { ...failed, error: NEEDS_PAIRING })).toBe(false);
		expect(needsProvider(plain, { ...failed, error: CONNECTION_LOST })).toBe(false);
		// A box with a provider is woken through it, or asks for its key.
		expect(needsProvider(sprite, failed)).toBe(false);
	});

	test("a box that sleeps rests asleep on its card through the tries in the background", () => {
		const timedOut = "connection timed out after 15000ms";
		// Untried, and its first try: most likely asleep, so no spinner.
		expect(shownAsleep(sprite, NEW_LINK)).toBe(true);
		expect(shownAsleep(sprite, { ...NEW_LINK, state: "connecting" })).toBe(true);
		// Found asleep, then tried again in the background: still asleep.
		const asleep: BoxLink = { ...NEW_LINK, state: "down", error: timedOut, asleep: true };
		expect(shownAsleep(sprite, asleep)).toBe(true);
		expect(shownAsleep(sprite, { ...asleep, state: "connecting" })).toBe(true);
		// A tap's try shows its steps, and one that lands shows it up.
		expect(shownAsleep(sprite, { ...asleep, state: "connecting", asked: true })).toBe(false);
		const up: BoxLink = { ...asleep, state: "live", asleep: false, error: null };
		expect(shownAsleep(sprite, up)).toBe(false);
		// After a drop or another failure it's being reached, not asleep.
		const dropped: BoxLink = { ...NEW_LINK, state: "connecting", error: CONNECTION_LOST };
		expect(shownAsleep(sprite, dropped)).toBe(false);
		expect(shownAsleep(sprite, { ...NEW_LINK, state: "down", error: NEEDS_PAIRING })).toBe(false);
		// A box that doesn't sleep is never shown asleep: its tries spin.
		for (const box of [plain, { ...sprite, sleeps: false }]) {
			expect(shownAsleep(box, { ...NEW_LINK, state: "connecting" })).toBe(false);
		}
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
