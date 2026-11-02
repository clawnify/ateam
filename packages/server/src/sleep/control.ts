// A box goes to sleep once nobody has used it for a while, and wakes for the
// next loop tick, on any provider with a SleepDriver (see ./index.ts).
//
// The provider can't make this call itself. It sleeps a box once its network goes
// quiet, but on an Ateam box that never happens on its own (the worktree sweep
// fetches every few minutes, a phone's Tailscale node talks to its relay), and it
// can't tell an agent mid-turn from one waiting on you. The engine can, so it
// decides, and the driver carries the decision out on the provider:
//
//   hold     keep the box awake. While it is in use, and for `idleSleepMinutes` after.
//   release  let the provider put it to sleep once nobody is connected and working.
//
// What counts as use (Seen):
//
//   agent       an agent mid-turn (Engine.isWorking).
//   lead        the box's own Lead mid-turn, or someone using its chat.
//   input       someone typing into a terminal on the box: a box shell counts,
//               though no agent works in it.
//   connection  a client connecting while the box is released: someone came
//               back to a box about to sleep, or one their connection just woke.
//   wake        the box waking up (idleTick), so a box woken to start a task
//               doesn't go straight back down before the task arrives.
//
// A connection to a box that is held counts for nothing. The desktop reconnects
// on its own, on every maintenance wake of a Mac asleep with its lid shut, and
// each of those used to restart the window: a box with no work stayed up all
// night (2026-11-02). Typing and the Lead say someone is there; a connection
// only says a client is.
//
// Before releasing a box with a live loop, the driver arms a wake for the next
// tick and the provider brings the box up for it. The engine's own timer then runs
// the loop: Node's clock keeps counting through sleep (measured on boxd), so a
// timer that came due while asleep fires the moment the box wakes.
//
// Every hold and release is logged with its time and its reason, and a held box
// says once an hour what last kept it up, so a night can be read back from the
// engine's log: `journalctl -u ateam` under the installer's service,
// ~/.ateam/daemon.log for an engine `ateam attach` started. Connections are not
// logged one by one.

/** How often the idle clock is checked. */
export const IDLE_CHECK_MS = 60_000;
/** A loop due this soon keeps the box held: waking for it would cost more than staying up. */
export const LOOP_SOON_MS = 2 * IDLE_CHECK_MS;
/** How often a held box's log says what keeps it up. */
export const HELD_NOTE_MS = 60 * 60_000;

/** What kept the box awake. */
export type Why = "start" | "agent" | "lead" | "input" | "connection" | "wake" | "off";

const WHY: Record<Why, string> = {
	start: "the engine started",
	agent: "agent work",
	lead: "the Lead chat",
	input: "typing in a terminal",
	connection: "a client connected while it was released",
	wake: "the box woke",
	off: "idle sleep is off",
};

/** Use seen on the box, and when. */
export interface Seen {
	why: Why;
	at: number;
}

export interface IdleClock {
	/** When use was last seen (or the clock last restarted). */
	lastActiveAt: number;
	/** What that use was. */
	why: Why;
	/** When the previous check ran. */
	lastCheckAt: number;
}

/**
 * One tick of the idle clock: has nobody used the box for `idleMs`? Pure, so the
 * rules are pinned without a box.
 *
 * Ongoing work is seen `at` now; input is seen at the moment it happened, so the
 * window runs from the last keystroke, not from the check that noticed it.
 *
 * A gap well past the check interval means this process was frozen: the box
 * just woke from sleep. The clock restarts then, because the sleep was not
 * idleness anyone chose: a box woken to start a task must not count the night
 * it slept through and go straight back down before the task arrives.
 */
export function idleTick(
	clock: IdleClock,
	input: { now: number; seen: Seen[]; idleMs: number; checkMs?: number },
): { clock: IdleClock; idle: boolean } {
	const { now, idleMs } = input;
	const checkMs = input.checkMs ?? IDLE_CHECK_MS;
	const seen: Seen[] = [];
	if (now - clock.lastCheckAt > 2 * checkMs) seen.push({ why: "wake", at: now });
	// Off (0) counts as use too, so turning the setting on starts a fresh
	// window rather than releasing on the next tick.
	if (idleMs <= 0) seen.push({ why: "off", at: now });
	seen.push(...input.seen);
	let { lastActiveAt, why } = clock;
	for (const s of seen) {
		const at = Math.min(s.at, now);
		if (at > lastActiveAt) {
			lastActiveAt = at;
			why = s.why;
		}
	}
	return {
		clock: { lastActiveAt, why, lastCheckAt: now },
		idle: idleMs > 0 && now - lastActiveAt >= idleMs,
	};
}

/**
 * Hold or release, given the idle clock and the loops. A loop the provider
 * can't wake the box for keeps it held, because a loop that silently never runs
 * is worse than a box that stays up.
 */
export function sleepMode(input: {
	idle: boolean;
	now: number;
	nextLoopAt: number | null;
	canWake: boolean;
}): "hold" | "release" {
	const { idle, now, nextLoopAt, canWake } = input;
	if (!idle) return "hold";
	if (nextLoopAt === null) return "release";
	if (!canWake || nextLoopAt - now < LOOP_SOON_MS) return "hold";
	return "release";
}

/** How the engine controls sleep on the provider of the box it runs on. */
export interface SleepDriver {
	/** For logs: "boxd machine mybox". */
	readonly where: string;
	/** Whether the provider can wake this box for a loop tick while it sleeps. */
	readonly canWakeForLoops: boolean;
	/** Keep the box awake. */
	hold(): Promise<void>;
	/** Let the provider put the box to sleep once it's quiet. */
	release(): Promise<void>;
	/** Have the provider wake the box at `at`. Called before a release with a loop due. */
	armWake(at: number): Promise<void>;
}

export interface SleepControlDeps {
	/** Agent work in progress (Engine.isWorking). */
	working: () => boolean;
	/** When someone last typed into a terminal on this box (Engine.lastInputAt), or null. */
	lastInputAt?: () => number | null;
	/** This box's own Lead: mid-turn, and when someone last used its chat. */
	lead?: () => { working: boolean; lastUsedAt: number | null };
	/** The earliest due tick of a loop that will run, or null. */
	nextLoopAt: () => number | null;
	/** Read on every tick, so a settings change applies within a minute. */
	idleMinutes: () => number;
	log: (line: string) => void;
	now?: () => number;
}

export interface SleepControl {
	stop(): void;
	/** Run one check now (tests drive it). A check asked for while one runs runs after it. */
	tick(): Promise<void>;
	/** A client connected. Counts as use only while the box is released. */
	touch(): void;
}

/** 2026-11-02T01:20:13Z */
const stamp = (t: number): string => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");

export async function startSleepControl(
	driver: SleepDriver,
	deps: SleepControlDeps,
): Promise<SleepControl> {
	const now = deps.now ?? Date.now;
	type Mode = "hold" | "release";
	// What the provider was last told, and what the last check decided. They
	// differ while the driver is carrying a decision out: a client connecting
	// mid-release must still count.
	let mode: Mode | null = null;
	let want: Mode | null = null;
	let armedAt: number | null = null;
	let clock: IdleClock = { lastActiveAt: now(), why: "start", lastCheckAt: now() };
	// When a client last connected to the released box.
	let connectedAt: number | null = null;
	// When the log last said why the box is held.
	let notedAt = 0;

	const say = (line: string) => deps.log(`[ateam] ${stamp(now())} ${line}`);
	const lastUse = () => `${WHY[clock.why]} at ${stamp(clock.lastActiveAt)}`;

	/** Carry `next` out; true when the provider was told something new. */
	const apply = async (next: Mode, why: string, nextLoopAt: number | null): Promise<boolean> => {
		want = next;
		if (next === "release" && nextLoopAt !== null && nextLoopAt !== armedAt) {
			await driver.armWake(nextLoopAt);
			armedAt = nextLoopAt;
		}
		if (next === mode) return false;
		await (next === "hold" ? driver.hold() : driver.release());
		say(
			next === "release"
				? `letting ${driver.where} sleep: ${why}`
				: `holding ${driver.where} awake: ${why}`,
		);
		mode = next;
		return true;
	};

	const check = async (): Promise<void> => {
		const minutes = deps.idleMinutes();
		const idleMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
		const t = now();
		const seen: Seen[] = [];
		if (deps.working()) seen.push({ why: "agent", at: t });
		const lead = deps.lead?.();
		if (lead?.working) seen.push({ why: "lead", at: t });
		if (lead?.lastUsedAt != null) seen.push({ why: "lead", at: lead.lastUsedAt });
		const typed = deps.lastInputAt?.();
		if (typed != null) seen.push({ why: "input", at: typed });
		if (connectedAt !== null) seen.push({ why: "connection", at: connectedAt });
		const step = idleTick(clock, { now: t, seen, idleMs });
		clock = step.clock;
		const nextLoopAt = deps.nextLoopAt();
		const canWake = driver.canWakeForLoops;
		const next = sleepMode({ idle: step.idle, now: t, nextLoopAt, canWake });
		let why = lastUse();
		if (step.idle && nextLoopAt !== null) {
			why = canWake
				? `a loop is due at ${stamp(nextLoopAt)}`
				: `a loop is due at ${stamp(nextLoopAt)}, and ${driver.where} can't be woken for it`;
		}
		if (next === "release") why = `nothing for ${minutes} min since ${lastUse()}`;
		if (await apply(next, why, nextLoopAt)) notedAt = t;
		else if (next === "hold" && t - notedAt >= HELD_NOTE_MS) {
			say(`still holding ${driver.where} awake: ${why}`);
			notedAt = t;
		}
	};

	// One check at a time. One asked for meanwhile (a client connecting while the
	// box is being released) runs right after, rather than being dropped.
	let running: Promise<void> | null = null;
	let again = false;
	const run = async (): Promise<void> => {
		do {
			again = false;
			try {
				await check();
			} catch (err) {
				say(`sleep control failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		} while (again);
	};
	const tick = (): Promise<void> => {
		if (running) {
			again = true;
			return running;
		}
		const p = run().finally(() => {
			running = null;
		});
		running = p;
		return p;
	};

	await tick(); // hold from the start: a fresh engine has no idea how long the box was idle
	const timer = setInterval(() => void tick(), IDLE_CHECK_MS);
	timer.unref?.();
	return {
		stop: () => clearInterval(timer),
		tick,
		// Someone connected to a box about to sleep, or to one their connection just
		// woke: hold it now and give them a fresh window. An idle connection is not
		// traffic a provider counts, so a released box would sleep under them.
		touch: () => {
			if (want !== "release") return;
			connectedAt = now();
			void tick();
		},
	};
}
