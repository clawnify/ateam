import { describe, expect, it } from "bun:test";
import { createSizeArbiter } from "../src/pty/size-arbiter";

// The user's actual complaint: a task open on the desktop AND on the phone, both
// against one box. The phone's terminal reported its size and the desktop's
// terminal shrank to phone dimensions — and stayed there, because the desktop
// only re-reports its size when its own grid changes.
const desktop = { cols: 200, rows: 50 };
const phone = { cols: 40, rows: 20 };

describe("size arbiter", () => {
	it("applies the first viewer's size and ignores a second viewer that just opens", () => {
		const a = createSizeArbiter();
		expect(a.resize("t", "desktop", desktop)).toEqual(desktop);
		// The phone opens the task: its fit is remembered, not applied.
		expect(a.resize("t", "phone", phone)).toBeNull();
		// The phone's keyboard shows and hides: still nothing reaches the PTY.
		expect(a.resize("t", "phone", { cols: 40, rows: 12 })).toBeNull();
		expect(a.resize("t", "phone", phone)).toBeNull();
	});

	it("hands the size to whoever types, and back again", () => {
		const a = createSizeArbiter();
		a.resize("t", "desktop", desktop);
		a.resize("t", "phone", phone);
		// Typing on the phone: it takes over, and its remembered size is applied
		// at once even though it has nothing new to report.
		expect(a.activity("t", "phone")).toEqual(phone);
		// Now the phone's own re-fits apply, the desktop's don't.
		expect(a.resize("t", "phone", { cols: 40, rows: 12 })).toEqual({ cols: 40, rows: 12 });
		expect(a.resize("t", "desktop", { cols: 210, rows: 50 })).toBeNull();
		// Back at the desk, the first keystroke restores the desktop's latest size.
		expect(a.activity("t", "desktop")).toEqual({ cols: 210, rows: 50 });
	});

	it("does not resize for a takeover when the PTY is already at that size", () => {
		const a = createSizeArbiter();
		a.resize("t", "desktop", desktop);
		// The owner typing again is not a resize.
		expect(a.activity("t", "desktop")).toBeNull();
		// Nor is a viewer reporting the size the PTY already has.
		expect(a.resize("t", "desktop", { ...desktop })).toBeNull();
	});

	it("a viewer that never reported a size takes over without resizing", () => {
		const a = createSizeArbiter();
		a.resize("t", "phone", phone);
		expect(a.activity("t", "cli")).toBeNull();
		// It now owns the size: the phone can no longer resize under it…
		expect(a.resize("t", "phone", { cols: 40, rows: 12 })).toBeNull();
		// …and its own first report applies.
		expect(a.resize("t", "cli", desktop)).toEqual(desktop);
	});

	it("releases a terminal when its owner disconnects, and forgets that viewer's sizes", () => {
		const a = createSizeArbiter();
		a.resize("t", "desktop", desktop);
		a.resize("t", "phone", phone);
		a.dropClient("desktop");
		// Nobody inherits automatically: the PTY keeps its size…
		// …until the next report claims it — the phone's keyboard re-fit here.
		expect(a.resize("t", "phone", phone)).toEqual(phone);
		// A reconnected desktop is a new client and can't be the old owner.
		expect(a.resize("t", "desktop-2", desktop)).toBeNull();
		expect(a.activity("t", "desktop-2")).toEqual(desktop);
	});

	it("keeps terminals independent", () => {
		const a = createSizeArbiter();
		a.resize("t1", "desktop", desktop);
		expect(a.resize("t2", "phone", phone)).toEqual(phone);
		expect(a.resize("t1", "phone", phone)).toBeNull();
	});

	it("forgets an exited terminal so a reused id starts clean", () => {
		const a = createSizeArbiter();
		a.resize("t", "desktop", desktop);
		a.forget("t");
		expect(a.resize("t", "phone", phone)).toEqual(phone);
	});
});
