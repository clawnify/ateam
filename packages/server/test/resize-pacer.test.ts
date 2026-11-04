import { describe, expect, test } from "bun:test";
import { createResizePacer, type PacerTimers, type PtySize } from "../src/pty/resize-pacer";

const GAP = 100;

// A clock the test moves by hand, so "within the gap" is exact.
function harness(initial: PtySize = { cols: 100, rows: 40 }) {
	let now = 0;
	let nextId = 0;
	const pending: { at: number; fn: () => void; id: number }[] = [];
	const timers: PacerTimers = {
		set(fn, ms) {
			const id = ++nextId;
			pending.push({ at: now + ms, fn, id });
			return id;
		},
		clear(handle) {
			const i = pending.findIndex((p) => p.id === handle);
			if (i >= 0) pending.splice(i, 1);
		},
	};
	const applied: string[] = [];
	const pacer = createResizePacer(initial, (s) => applied.push(`${s.cols}x${s.rows}`), GAP, timers);
	const advance = (ms: number) => {
		const end = now + ms;
		for (;;) {
			pending.sort((a, b) => a.at - b.at);
			const due = pending[0];
			if (!due || due.at > end) break;
			pending.shift();
			now = due.at;
			due.fn();
		}
		now = end;
	};
	const ask = (cols: number, rows: number) => pacer.request({ cols, rows });
	return { pacer, applied, advance, ask, pending };
}

describe("resize pacer", () => {
	test("a lone resize reaches the PTY at once", () => {
		const h = harness();
		h.ask(120, 50);
		expect(h.applied).toEqual(["120x50"]);
	});

	test("a tile that shrinks and grows straight back: the program sees both sizes", () => {
		// The two resizes arrive back to back (queued behind a busy engine).
		// Applied back to back, the program reads 100x40 twice and never repaints.
		const h = harness();
		h.ask(100, 33);
		h.ask(100, 40);
		expect(h.applied).toEqual(["100x33"]);
		h.advance(GAP - 1);
		expect(h.applied).toEqual(["100x33"]);
		h.advance(1);
		expect(h.applied).toEqual(["100x33", "100x40"]);
	});

	test("resizes inside the gap collapse to the newest", () => {
		const h = harness();
		h.ask(100, 39); // a window drag: one size per frame
		h.ask(100, 37);
		h.ask(100, 35);
		h.ask(100, 30);
		h.advance(GAP);
		expect(h.applied).toEqual(["100x39", "100x30"]);
	});

	test("a batch that ends where the PTY already is goes through its last-but-one size first", () => {
		const h = harness();
		h.ask(100, 35); // applied at once; the gap starts
		h.ask(100, 28);
		h.ask(100, 30);
		h.ask(100, 35); // back to what the PTY has
		h.advance(GAP);
		expect(h.applied).toEqual(["100x35", "100x30"]);
		h.advance(GAP);
		expect(h.applied).toEqual(["100x35", "100x30", "100x35"]);
		h.advance(GAP * 5);
		expect(h.applied).toEqual(["100x35", "100x30", "100x35"]);
	});

	test("a request for the size the PTY has, or the one already queued, changes nothing", () => {
		const h = harness();
		h.ask(100, 40);
		expect(h.applied).toEqual([]);
		h.ask(100, 33);
		h.ask(100, 30);
		h.ask(100, 30);
		h.advance(GAP);
		expect(h.applied).toEqual(["100x33", "100x30"]);
	});

	test("the gap ends quietly when nothing new was asked", () => {
		const h = harness();
		h.ask(80, 24);
		h.advance(GAP * 3);
		expect(h.applied).toEqual(["80x24"]);
		expect(h.pending).toHaveLength(0);
		h.ask(81, 24); // after the gap: at once again
		expect(h.applied).toEqual(["80x24", "81x24"]);
	});

	test("disposing drops a queued resize", () => {
		const h = harness();
		h.ask(100, 33);
		h.ask(100, 40);
		h.pacer.dispose();
		h.advance(GAP * 2);
		expect(h.applied).toEqual(["100x33"]);
		expect(h.pending).toHaveLength(0);
	});
});
