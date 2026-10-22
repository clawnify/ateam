import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boxdMachineName, boxdSleepDriver, loopWakeScript, RELEASE_S } from "../src/sleep/boxd";
import {
	IDLE_CHECK_MS,
	type IdleClock,
	idleTick,
	LOOP_SOON_MS,
	type SleepDriver,
	sleepMode,
	startSleepControl,
} from "../src/sleep/control";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Minute-by-minute checks from `clock`; the minute it first reads idle, or null. */
function idleAfter(
	clock: IdleClock,
	minutes: number,
	opts: { working?: (minute: number) => boolean; idleMs?: number } = {},
): { clock: IdleClock; idleAt: number | null } {
	let c = clock;
	for (let m = 1; m <= minutes; m++) {
		const step = idleTick(c, {
			now: clock.lastCheckAt + m * IDLE_CHECK_MS,
			working: opts.working?.(m) ?? false,
			idleMs: opts.idleMs ?? HOUR,
		});
		c = step.clock;
		if (step.idle) return { clock: c, idleAt: m };
	}
	return { clock: c, idleAt: null };
}

describe("idleTick", () => {
	const start: IdleClock = { lastActiveAt: 0, lastCheckAt: 0 };

	it("reads idle an hour after the last agent work", () => {
		expect(idleAfter(start, 120).idleAt).toBe(60);
		expect(idleAfter(start, 200, { working: (m) => m <= 30 }).idleAt).toBe(90);
	});

	it("never while work goes on, and never when set to 0", () => {
		expect(idleAfter(start, 500, { working: () => true }).idleAt).toBeNull();
		expect(idleAfter(start, 500, { idleMs: 0 }).idleAt).toBeNull();
	});

	it("a box just woken gets a fresh hour, not an instant release", () => {
		// Idle 59 minutes, then frozen 10 hours.
		const before = idleAfter(start, 59).clock;
		const woke = idleTick(before, {
			now: before.lastCheckAt + 10 * HOUR,
			working: false,
			idleMs: HOUR,
		});
		expect(woke.idle).toBe(false);
		expect(idleAfter(woke.clock, 120).idleAt).toBe(60);
	});

	it("turning the setting on starts the hour then, not in the past", () => {
		const off = idleAfter(start, 300, { idleMs: 0 }).clock;
		expect(idleAfter(off, 120).idleAt).toBe(60);
	});
});

describe("sleepMode", () => {
	const now = 1_000_000;

	it("holds until idle, then releases when no loop waits", () => {
		expect(sleepMode({ idle: false, now, nextLoopAt: null, canWake: true })).toBe("hold");
		expect(sleepMode({ idle: true, now, nextLoopAt: null, canWake: true })).toBe("release");
	});

	it("releases with a later loop only when boxd can wake the box for it", () => {
		const later = now + HOUR;
		expect(sleepMode({ idle: true, now, nextLoopAt: later, canWake: true })).toBe("release");
		// No `run` on an old image: the loop would silently never run, so stay up.
		expect(sleepMode({ idle: true, now, nextLoopAt: later, canWake: false })).toBe("hold");
	});

	it("holds when a loop is due any moment", () => {
		expect(sleepMode({ idle: true, now, nextLoopAt: now + LOOP_SOON_MS - 1, canWake: true })).toBe(
			"hold",
		);
	});
});

describe("loopWakeScript", () => {
	it("is a one-minute UTC cron for the tick", () => {
		const at = Date.UTC(2026, 9, 22, 9, 5, 30); // 22 Oct 2026 09:05:30 UTC
		expect(loopWakeScript(at)).toContain('every("5 9 22 10 *"');
	});
});

describe("sleep control on boxd", () => {
	function harness(opts: { run?: boolean; nextLoopAt?: number | null } = {}) {
		let t = 0;
		let working = false;
		const calls: string[] = [];
		const dir = mkdtempSync(join(tmpdir(), "ateam-boxd-"));
		const wakeScriptPath = join(dir, "loop-wake.run.ts");
		const exec = async (cmd: string, args: string[]) => {
			if (cmd === "boxd" && args[0] === "info") return JSON.stringify({ name: "mybox" });
			if (cmd === "run" && args[0] === "--help") {
				if (opts.run === false) throw new Error("run: not found");
				return "";
			}
			calls.push(`${cmd} ${args.join(" ")}`);
			return "";
		};
		const deps = {
			working: () => working,
			nextLoopAt: () => opts.nextLoopAt ?? null,
			idleMinutes: () => 60,
			log: () => {},
			now: () => t,
		};
		return {
			deps,
			calls,
			wakeScriptPath,
			start: async () => {
				const driver = await boxdSleepDriver({ log: () => {}, exec, wakeScriptPath });
				if (!driver) throw new Error("expected the boxd driver");
				return startSleepControl(driver, deps);
			},
			advance: (ms: number) => {
				t += ms;
			},
			setWorking: (w: boolean) => {
				working = w;
			},
		};
	}

	/** Tick once a minute for `minutes`. */
	async function minutes(h: ReturnType<typeof harness>, tick: () => Promise<void>, n: number) {
		for (let i = 0; i < n; i++) {
			h.advance(IDLE_CHECK_MS);
			await tick();
		}
	}

	it("holds at start, releases through boxd's own timer after the idle hour", async () => {
		const h = harness();
		const { stop, tick } = await h.start();
		expect(h.calls).toEqual(["boxd machine config set auto-hibernate.timeout 0"]);
		await minutes(h, tick, 60);
		// Never `boxd machine hibernate`: a box hibernated on command is not woken for jobs.
		expect(h.calls.slice(1)).toEqual([
			"boxd machine config set idle.ignore-outbound on",
			`boxd machine config set auto-hibernate.timeout ${RELEASE_S}`,
		]);
		// Work again: held, once.
		h.setWorking(true);
		await minutes(h, tick, 3);
		expect(h.calls.slice(3)).toEqual(["boxd machine config set auto-hibernate.timeout 0"]);
		stop();
	});

	it("a client attaching to a released box holds it and restarts the window", async () => {
		const h = harness();
		const box = await h.start();
		await minutes(h, box.tick, 60);
		expect(h.calls.at(-1)).toBe(`boxd machine config set auto-hibernate.timeout ${RELEASE_S}`);
		// Woken a moment later by the desktop connecting: no freeze long enough to
		// read as a wake, so only the attach itself can say someone is here.
		h.advance(10_000);
		box.touch();
		// touch() starts a check without waiting for it; let it finish, or the next
		// check would be skipped as overlapping and its gap read as a wake.
		await new Promise((r) => setTimeout(r, 0));
		expect(h.calls.at(-1)).toBe("boxd machine config set auto-hibernate.timeout 0");
		const held = h.calls.length;
		await minutes(h, box.tick, 59);
		expect(h.calls.length).toBe(held); // still held inside the fresh window
		await minutes(h, box.tick, 1);
		expect(h.calls.at(-1)).toBe(`boxd machine config set auto-hibernate.timeout ${RELEASE_S}`);
		box.stop();
	});

	it("arms the loop-wake job before releasing", async () => {
		const at = 3 * HOUR;
		const h = harness({ nextLoopAt: at });
		const { stop, tick } = await h.start();
		await minutes(h, tick, 60);
		expect(h.calls.slice(1, 2)).toEqual([`run ${h.wakeScriptPath}`]);
		expect(readFileSync(h.wakeScriptPath, "utf8")).toBe(loopWakeScript(at));
		expect(h.calls.at(-1)).toBe(`boxd machine config set auto-hibernate.timeout ${RELEASE_S}`);
		stop();
	});

	it("without `run`, a box with a loop stays held", async () => {
		const h = harness({ run: false, nextLoopAt: 5 * HOUR });
		const { stop, tick } = await h.start();
		await minutes(h, tick, 120);
		expect(h.calls).toEqual(["boxd machine config set auto-hibernate.timeout 0"]);
		stop();
	});
});

describe("boxdMachineName", () => {
	it("reads the in-VM CLI's name", async () => {
		const name = await boxdMachineName(async () => JSON.stringify({ name: "ateam-probe" }));
		expect(name).toBe("ateam-probe");
	});

	it("is null off a boxd VM: laptop CLI rejects `info`, or no boxd at all", async () => {
		expect(
			await boxdMachineName(async () => {
				throw new Error("unrecognized subcommand 'info'");
			}),
		).toBeNull();
		expect(await boxdMachineName(async () => "not json")).toBeNull();
		expect(await boxdMachineName(async () => JSON.stringify({}))).toBeNull();
	});
});

describe("boxdSleepDriver", () => {
	it("answers nothing off a boxd VM, so another provider's driver can", async () => {
		const driver = await boxdSleepDriver({
			log: () => {},
			exec: async () => {
				throw new Error("boxd: command not found");
			},
		});
		expect(driver).toBeNull();
	});
});

describe("startSleepControl", () => {
	it("drives any provider through the same three calls", async () => {
		// No boxd here: the decision is the engine's, the driver only carries it out.
		const calls: string[] = [];
		const driver: SleepDriver = {
			where: "test box",
			canWakeForLoops: true,
			hold: async () => {
				calls.push("hold");
			},
			release: async () => {
				calls.push("release");
			},
			armWake: async (at) => {
				calls.push(`armWake ${at}`);
			},
		};
		let t = 0;
		const control = await startSleepControl(driver, {
			working: () => false,
			nextLoopAt: () => 3 * HOUR,
			idleMinutes: () => 60,
			log: () => {},
			now: () => t,
		});
		for (let m = 0; m < 60; m++) {
			t += IDLE_CHECK_MS;
			await control.tick();
		}
		expect(calls).toEqual(["hold", `armWake ${3 * HOUR}`, "release"]);
		control.stop();
	});
});
