import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boxdMachineName, boxdSleepDriver, loopWakeScript, RELEASE_S } from "../src/sleep/boxd";
import {
	HELD_NOTE_MS,
	IDLE_CHECK_MS,
	type IdleClock,
	idleTick,
	LOOP_SOON_MS,
	type SleepControlDeps,
	type SleepDriver,
	sleepMode,
	startSleepControl,
} from "../src/sleep/control";
import { providerReport } from "../src/sleep/index";
import {
	HOLD_EXPIRE,
	HOLD_RENEW_MS,
	HOLD_TASK,
	spritesSleepDriver,
	type TaskCall,
} from "../src/sleep/sprites";

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
		const now = clock.lastCheckAt + m * IDLE_CHECK_MS;
		const step = idleTick(c, {
			now,
			seen: opts.working?.(m) ? [{ why: "agent", at: now }] : [],
			idleMs: opts.idleMs ?? HOUR,
		});
		c = step.clock;
		if (step.idle) return { clock: c, idleAt: m };
	}
	return { clock: c, idleAt: null };
}

describe("idleTick", () => {
	const start: IdleClock = { lastActiveAt: 0, why: "start", lastCheckAt: 0 };

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
			seen: [],
			idleMs: HOUR,
		});
		expect(woke.idle).toBe(false);
		expect(woke.clock.why).toBe("wake");
		expect(idleAfter(woke.clock, 120).idleAt).toBe(60);
	});

	it("input counts from the moment it happened, not from the check that saw it", () => {
		// Typed 30.5 minutes in: idle an hour after that, read on the check at 91.
		let c = start;
		let idleAt: number | null = null;
		for (let m = 1; m <= 120 && idleAt === null; m++) {
			const step = idleTick(c, {
				now: m * IDLE_CHECK_MS,
				seen: m >= 31 ? [{ why: "input", at: 30.5 * IDLE_CHECK_MS }] : [],
				idleMs: HOUR,
			});
			c = step.clock;
			if (step.idle) idleAt = m;
		}
		expect(idleAt).toBe(91);
		expect(c).toMatchObject({ why: "input", lastActiveAt: 30.5 * IDLE_CHECK_MS });
	});

	it("input older than the window it would extend changes nothing", () => {
		const woke = idleTick(start, { now: 10 * HOUR, seen: [], idleMs: HOUR });
		// The last keystroke was before the box slept: the wake's window stands.
		const step = idleTick(woke.clock, {
			now: 10 * HOUR + IDLE_CHECK_MS,
			seen: [{ why: "input", at: HOUR }],
			idleMs: HOUR,
		});
		expect(step.clock).toMatchObject({ why: "wake", lastActiveAt: 10 * HOUR });
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
			// A read of boxd's own timeout, not a change: answers what Ateam set last.
			if (cmd === "boxd" && args.join(" ") === "machine config list --json") {
				return JSON.stringify({ "auto-hibernate.timeout": RELEASE_S });
			}
			calls.push(`${cmd} ${args.join(" ")}`);
			return "";
		};
		const timeoutStatePath = join(dir, "auto-hibernate-set");
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
				const driver = await boxdSleepDriver({
					log: () => {},
					exec,
					wakeScriptPath,
					timeoutStatePath,
				});
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

	// boxd's other idle timer, off on every hold and release: on, it suspends a held box.
	const SUSPEND_OFF = "boxd machine config set auto-suspend.timeout 0";

	it("holds at start, releases through boxd's own timer after the idle hour", async () => {
		const h = harness();
		const { stop, tick } = await h.start();
		expect(h.calls).toEqual([SUSPEND_OFF, "boxd machine config set auto-hibernate.timeout 0"]);
		await minutes(h, tick, 60);
		// Never `boxd machine hibernate`: a box hibernated on command is not woken for jobs.
		expect(h.calls.slice(2)).toEqual([
			"boxd machine config set idle.ignore-outbound on",
			SUSPEND_OFF,
			`boxd machine config set auto-hibernate.timeout ${RELEASE_S}`,
		]);
		// Work again: held, once.
		h.setWorking(true);
		await minutes(h, tick, 3);
		expect(h.calls.slice(5)).toEqual([SUSPEND_OFF, "boxd machine config set auto-hibernate.timeout 0"]);
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
		// touch() starts a check without waiting for it; let it finish.
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
		expect(h.calls.slice(2, 3)).toEqual([`run ${h.wakeScriptPath}`]);
		expect(readFileSync(h.wakeScriptPath, "utf8")).toBe(loopWakeScript(at));
		expect(h.calls.at(-1)).toBe(`boxd machine config set auto-hibernate.timeout ${RELEASE_S}`);
		stop();
	});

	it("without `run`, a box with a loop stays held", async () => {
		const h = harness({ run: false, nextLoopAt: 5 * HOUR });
		const { stop, tick } = await h.start();
		await minutes(h, tick, 120);
		expect(h.calls).toEqual([SUSPEND_OFF, "boxd machine config set auto-hibernate.timeout 0"]);
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

	it("says it is the boxd machine it runs on, for clients to wake it through", async () => {
		const driver = await boxdSleepDriver({
			log: () => {},
			exec: async (cmd, args) => (cmd === "boxd" && args[0] === "info" ? '{"name":"mybox"}' : ""),
			timeoutStatePath: join(
				mkdtempSync(join(tmpdir(), "ateam-boxd-state-")),
				"auto-hibernate-set",
			),
		});
		expect(driver?.provider).toEqual({ id: "boxd", box: { machine: "mybox" } });
	});
});

describe("boxd's own always on", () => {
	/** A boxd VM whose auto-hibernate timeout is `timeout()`, recording what Ateam sets. */
	function vm(timeout: () => number) {
		const sets: string[] = [];
		const exec = async (cmd: string, args: string[]) => {
			if (cmd === "boxd" && args[0] === "info") return JSON.stringify({ name: "mybox" });
			if (cmd === "boxd" && args.join(" ") === "machine config list --json") {
				return JSON.stringify({ "auto-hibernate.timeout": timeout(), "auto-suspend.timeout": 0 });
			}
			if (cmd === "boxd" && args[0] === "machine" && args[1] === "config" && args[2] === "set") {
				sets.push(`${args[3]}=${args[4]}`);
			}
			return "";
		};
		const statePath = join(mkdtempSync(join(tmpdir(), "ateam-boxd-state-")), "auto-hibernate-set");
		return { exec, sets, statePath };
	}

	it("an upgraded box reads nothing into a 0: it may be Ateam's own hold", async () => {
		const v = vm(() => 0);
		let alwaysOn = 0;
		const d = await boxdSleepDriver({
			log: () => {},
			exec: v.exec,
			timeoutStatePath: v.statePath,
			onAlwaysOn: () => alwaysOn++,
		});
		await d?.hold();
		expect(alwaysOn).toBe(0);
	});

	it("hibernation turned off in boxd after Ateam let the box sleep is kept, not undone", async () => {
		let t = 0;
		const v = vm(() => t);
		let alwaysOn = 0;
		const d = await boxdSleepDriver({
			log: () => {},
			exec: v.exec,
			timeoutStatePath: v.statePath,
			onAlwaysOn: () => alwaysOn++,
		});
		if (!d) throw new Error("expected the boxd driver");
		await d.release();
		t = RELEASE_S;
		await d.hold();
		expect(alwaysOn).toBe(0);
		await d.release();
		// The user turns hibernation off in boxd while Ateam has it released.
		t = 0;
		await d.hold();
		expect(alwaysOn).toBe(1);
		// The record survives a restart: a new engine tells the same change apart.
		await d.release();
		t = 0;
		const again = await boxdSleepDriver({
			log: () => {},
			exec: v.exec,
			timeoutStatePath: v.statePath,
			onAlwaysOn: () => alwaysOn++,
		});
		await again?.hold();
		expect(alwaysOn).toBe(2);
	});
});

describe("providerReport", () => {
	const sprite = { id: "sprites", box: { machine: "ateam-box" } };
	it("says the box sleeps while idle sleep is on, and not while it's off (always on)", () => {
		expect(providerReport(sprite, 60)).toEqual({ ...sprite, sleeps: true });
		expect(providerReport(sprite, 0)).toEqual({ ...sprite, sleeps: false });
		expect(providerReport(sprite, Number.NaN)).toEqual({ ...sprite, sleeps: false });
	});
	it("passes on not knowing yet, and no provider", () => {
		expect(providerReport(undefined, 60)).toBeUndefined();
		expect(providerReport(null, 60)).toBeNull();
	});
});

describe("spritesSleepDriver", () => {
	const PUT = `PUT ${HOLD_TASK} ${JSON.stringify({ expire: HOLD_EXPIRE })}`;

	/** A Sprite whose API socket answers `status(method)`, with the renewal timer in hand. */
	function sprite(status: (method: string) => number = (m) => (m === "PUT" ? 200 : 204)) {
		const calls: string[] = [];
		let renew: (() => void) | null = null;
		let renewEvery: number | null = null;
		const call: TaskCall = async (method, task, body) => {
			calls.push(`${method} ${task}${body ? ` ${body}` : ""}`);
			return status(method);
		};
		const driver = () =>
			spritesSleepDriver({
				log: () => {},
				isSprite: () => true,
				call,
				every: (fn, ms) => {
					renew = fn;
					renewEvery = ms;
					return () => {
						renew = null;
					};
				},
			});
		return {
			calls,
			driver,
			renew: () => renew?.(),
			renewing: () => renew !== null,
			renewEvery: () => renewEvery,
		};
	}

	it("answers nothing off a Sprite, so another provider's driver can", async () => {
		expect(await spritesSleepDriver({ log: () => {}, isSprite: () => false })).toBeNull();
	});

	it("says it is the Sprite it runs on, by its name, for clients to wake it through", async () => {
		const d = await spritesSleepDriver({ log: () => {}, isSprite: () => true, name: "ateam-box" });
		expect(d?.provider).toEqual({ id: "sprites", box: { machine: "ateam-box" } });
	});

	it("holds with a task it keeps renewing, and releases by deleting it", async () => {
		const s = sprite();
		const d = await s.driver();
		if (!d) throw new Error("expected the Sprites driver");
		expect(d.canWakeForLoops).toBe(false);
		await d.hold();
		expect(s.renewEvery()).toBe(HOLD_RENEW_MS);
		s.renew();
		s.renew();
		await d.release();
		expect(s.calls).toEqual([PUT, PUT, PUT, `DELETE ${HOLD_TASK}`]);
		expect(s.renewing()).toBe(false);
	});

	it("a refused hold throws and starts no renewals, so the next tick tries again", async () => {
		const s = sprite(() => 400);
		const d = await s.driver();
		if (!d) throw new Error("expected the Sprites driver");
		await expect(d.hold()).rejects.toThrow("HTTP 400");
		expect(s.renewing()).toBe(false);
	});

	it("releasing a hold that already lapsed is fine", async () => {
		const s = sprite(() => 404);
		const d = await s.driver();
		if (!d) throw new Error("expected the Sprites driver");
		await d.release();
		expect(s.calls).toEqual([`DELETE ${HOLD_TASK}`]);
	});

	it("under sleep control: holds at start, deletes the hold after the idle hour", async () => {
		const s = sprite();
		const d = await s.driver();
		if (!d) throw new Error("expected the Sprites driver");
		let t = 0;
		const control = await startSleepControl(d, {
			working: () => false,
			nextLoopAt: () => null,
			idleMinutes: () => 60,
			log: () => {},
			now: () => t,
		});
		for (let m = 0; m < 61; m++) {
			t += IDLE_CHECK_MS;
			await control.tick();
		}
		expect(s.calls).toEqual([PUT, `DELETE ${HOLD_TASK}`]);
		control.stop();
	});

	it("can't wake for a loop, so a Sprite with one stays held", async () => {
		const s = sprite();
		const d = await s.driver();
		if (!d) throw new Error("expected the Sprites driver");
		let t = 0;
		const control = await startSleepControl(d, {
			working: () => false,
			nextLoopAt: () => 5 * HOUR,
			idleMinutes: () => 60,
			log: () => {},
			now: () => t,
		});
		for (let m = 0; m < 120; m++) {
			t += IDLE_CHECK_MS;
			await control.tick();
		}
		expect(s.calls).toEqual([PUT]);
		control.stop();
	});
});

describe("startSleepControl", () => {
	it("drives any provider through the same three calls", async () => {
		// No boxd here: the decision is the engine's, the driver only carries it out.
		const calls: string[] = [];
		const driver: SleepDriver = {
			where: "test box",
			provider: { id: "boxd", box: { machine: "test-box" } },
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

describe("what keeps a box awake", () => {
	// The night of 2026-11-02 (UTC): the engine started at 23:51.
	const T0 = Date.UTC(2026, 10, 1, 23, 51);
	const at = (minute: number) => new Date(T0 + minute * MIN).toISOString().replace(".000Z", "Z");

	/** A box under sleep control with a recording driver; calls read "hold@<minute>". */
	async function box(opts: { release?: () => Promise<void>; idleMinutes?: number } = {}) {
		let t = T0;
		const minute = () => (t - T0) / MIN;
		let working = false;
		let typedAt: number | null = null;
		const lead = { working: false, lastUsedAt: null as number | null };
		const calls: string[] = [];
		const logs: string[] = [];
		const driver: SleepDriver = {
			where: "test box",
			provider: { id: "boxd", box: { machine: "test-box" } },
			canWakeForLoops: true,
			hold: async () => {
				calls.push(`hold@${minute()}`);
			},
			release: async () => {
				await opts.release?.();
				calls.push(`release@${minute()}`);
			},
			armWake: async () => {},
		};
		const deps: SleepControlDeps = {
			working: () => working,
			lastInputAt: () => typedAt,
			lead: () => ({ ...lead }),
			nextLoopAt: () => null,
			idleMinutes: () => opts.idleMinutes ?? 60,
			log: (line) => logs.push(line),
			now: () => t,
		};
		const control = await startSleepControl(driver, deps);
		const b = {
			calls,
			logs,
			lead,
			control,
			minute,
			setWorking: (w: boolean) => {
				working = w;
			},
			/** Someone types into a terminal at `m` minutes in (now, by default). */
			type: (m = minute()) => {
				typedAt = T0 + m * MIN;
			},
			/** Run the once-a-minute check up to `to`, doing `each(m)` before each one. */
			async until(to: number, each?: (m: number) => void) {
				while (minute() < to) {
					t += IDLE_CHECK_MS;
					each?.(minute());
					await control.tick();
				}
			},
			/** Frozen, as a sleeping box is: no checks run. */
			sleep(minutes: number) {
				t += minutes * MIN;
			},
			advance(ms: number) {
				t += ms;
			},
		};
		return b;
	}

	const settle = () => new Promise((r) => setTimeout(r, 0));

	it("a client reconnecting every 15 minutes to a held box with no work: released after the window", async () => {
		const b = await box();
		await b.until(60, (m) => {
			if (m % 15 === 0) b.control.touch(); // the desktop, on each maintenance wake of a sleeping Mac
		});
		await settle();
		// Before: each reconnect bought another hour, and the box never slept.
		expect(b.calls).toEqual(["hold@0", "release@60"]);
		// Once asleep the desktop doesn't dial it (host.ts reconnect asks the provider
		// first), so nothing comes back until someone uses it.
		expect(b.logs.join("\n")).not.toContain("connected");
		b.control.stop();
	});

	it("typing in a box shell keeps it up for the window after the last keystroke", async () => {
		const b = await box();
		await b.until(50);
		b.type(50.25); // between two checks
		await b.until(200);
		expect(b.calls).toEqual(["hold@0", "release@111"]);
		b.control.stop();
	});

	it("a Lead turn holds the box, and so does using its chat", async () => {
		const b = await box();
		await b.until(70, (m) => {
			b.lead.working = m <= 70; // mid-turn until minute 70
		});
		b.lead.working = false;
		await b.until(200);
		expect(b.calls).toEqual(["hold@0", "release@130"]);

		// Asleep, woken, then a message in the chat at minute 20 of the new window.
		const c = await box();
		await c.until(20);
		c.lead.lastUsedAt = T0 + 20 * MIN;
		await c.until(200);
		expect(c.calls).toEqual(["hold@0", "release@80"]);
		b.control.stop();
		c.control.stop();
	});

	it("a box woken by a phone or the desktop gets a fresh window", async () => {
		const b = await box();
		await b.until(60);
		expect(b.calls).toEqual(["hold@0", "release@60"]);
		b.sleep(7 * 60); // asleep until morning
		b.control.touch(); // the phone's connection, right after its wake
		await settle();
		expect(b.calls).toEqual(["hold@0", "release@60", "hold@480"]);
		// The connection reads as the reason, or the wake does: either way a fresh window.
		await b.until(600);
		expect(b.calls).toEqual(["hold@0", "release@60", "hold@480", "release@540"]);
		b.control.stop();
	});

	it("a client connecting to a released box holds it, even while the release is under way", async () => {
		let finish: () => void = () => {};
		let releases = 0;
		const b = await box({
			release: () =>
				// The first release is slow (boxd's CLI takes seconds); the next is not.
				++releases === 1 ? new Promise<void>((r) => (finish = r)) : Promise.resolve(),
		});
		await b.until(59);
		b.advance(IDLE_CHECK_MS);
		const releasing = b.control.tick();
		await settle();
		b.control.touch(); // someone opens the app as the box is being let go
		finish();
		await releasing;
		await settle();
		expect(b.calls).toEqual(["hold@0", "release@60", "hold@60"]);
		await b.until(200);
		expect(b.calls).toEqual(["hold@0", "release@60", "hold@60", "release@120"]);
		b.control.stop();
	});

	it("logs each hold and release with its time and why, and what keeps a held box up once an hour", async () => {
		const b = await box();
		await b.until(10);
		b.type();
		await b.until(70);
		b.sleep(5 * 60);
		await b.until(380);
		b.setWorking(true);
		await b.until(380 + 150);
		expect(b.logs).toEqual([
			`[ateam] ${at(0)} holding test box awake: the engine started at ${at(0)}`,
			`[ateam] ${at(60)} still holding test box awake: typing in a terminal at ${at(10)}`,
			`[ateam] ${at(70)} letting test box sleep: nothing for 60 min since typing in a terminal at ${at(10)}`,
			`[ateam] ${at(371)} holding test box awake: the box woke at ${at(371)}`,
			`[ateam] ${at(371 + HELD_NOTE_MS / MIN)} still holding test box awake: agent work at ${at(371 + HELD_NOTE_MS / MIN)}`,
			`[ateam] ${at(371 + (2 * HELD_NOTE_MS) / MIN)} still holding test box awake: agent work at ${at(371 + (2 * HELD_NOTE_MS) / MIN)}`,
		]);
		b.control.stop();
	});
});
