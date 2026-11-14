import { describe, expect, it } from "bun:test";
import { createConnLog, formatEntry } from "./conn-log";

describe("the phone's connection log", () => {
	it("reads as one UTC line per event, oldest first", () => {
		let now = Date.UTC(2026, 10, 14, 10, 30, 41);
		const log = createConnLog({ now: () => now });
		log.add(null, "app active");
		now += 9_000;
		log.add("box-a", "no answer in 4000 ms (keepalive): socket closed");
		expect(log.text()).toBe(
			[
				"2026-11-14 10:30:41Z  app  app active",
				"2026-11-14 10:30:50Z  box-a  no answer in 4000 ms (keepalive): socket closed",
			].join("\n"),
		);
	});

	it("keeps the newest entries once it is full", () => {
		let now = 0;
		const log = createConnLog({ cap: 3, now: () => now++ });
		for (const e of ["a", "b", "c", "d", "e"]) log.add(null, e);
		expect(log.entries().map((e) => e.event)).toEqual(["c", "d", "e"]);
	});

	it("puts an earlier run's log back under what this run already wrote", () => {
		const earlier = createConnLog({ now: () => 1_000 });
		earlier.add("box-a", "link dropped");
		const log = createConnLog({ now: () => 2_000 });
		log.add(null, "app started");
		log.restore(earlier.serialize());
		expect(log.entries().map((e) => e.event)).toEqual(["link dropped", "app started"]);
	});

	it("a kept log that can't be read costs nothing", () => {
		const log = createConnLog({ now: () => 5 });
		log.add(null, "app started");
		log.restore("{not json");
		log.restore(JSON.stringify([{ at: "soon", event: 3 }, null]));
		expect(log.entries()).toHaveLength(1);
	});

	it("tells whoever is reading it about each change", () => {
		const log = createConnLog();
		let seen = 0;
		const off = log.subscribe(() => seen++);
		log.add(null, "app active");
		off();
		log.add(null, "app background");
		expect(seen).toBe(1);
		expect(formatEntry({ at: 0, box: null, event: "x" })).toBe("1970-01-01 00:00:00Z  app  x");
	});
});
