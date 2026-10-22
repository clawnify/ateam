// A box goes to sleep once no agent has worked on it for a while, and wakes for
// the next loop tick, on any provider with a SleepDriver (see ./index.ts).
//
// The provider can't make this call itself. It sleeps a box once its network goes
// quiet, but on an Ateam box that never happens on its own (the worktree sweep
// fetches every few minutes, a phone's Tailscale node talks to its relay), and it
// can't tell an agent mid-turn from one waiting on you. The engine can, so it
// decides, and the driver carries the decision out on the provider:
//
//   hold     keep the box awake. While an agent works, and for `idleSleepMinutes` after.
//   release  let the provider put it to sleep once nobody is connected and working.
//
// Before releasing a box with a live loop, the driver arms a wake for the next
// tick and the provider brings the box up for it. The engine's own timer then runs
// the loop: Node's clock keeps counting through sleep (measured on boxd), so a
// timer that came due while asleep fires the moment the box wakes.

/** How often the idle clock is checked. */
export const IDLE_CHECK_MS = 60_000;
/** A loop due this soon keeps the box held: waking for it would cost more than staying up. */
export const LOOP_SOON_MS = 2 * IDLE_CHECK_MS;

export interface IdleClock {
	/** When work was last seen (or the clock last restarted). */
	lastActiveAt: number;
	/** When the previous check ran. */
	lastCheckAt: number;
}

/**
 * One tick of the idle clock: has no agent worked for `idleMs`? Pure, so the
 * rules are pinned without a box.
 *
 * A gap well past the check interval means this process was frozen: the box
 * just woke from sleep. The clock restarts then, because the sleep was not
 * idleness anyone chose: a box woken to start a task must not count the night
 * it slept through and go straight back down before the task arrives.
 */
export function idleTick(
	clock: IdleClock,
	input: { now: number; working: boolean; idleMs: number; checkMs?: number },
): { clock: IdleClock; idle: boolean } {
	const { now, working, idleMs } = input;
	const checkMs = input.checkMs ?? IDLE_CHECK_MS;
	const woke = now - clock.lastCheckAt > 2 * checkMs;
	// Off (0) counts as active too, so turning the setting on starts a fresh
	// window rather than releasing on the next tick.
	const active = working || woke || idleMs <= 0;
	const lastActiveAt = active ? now : clock.lastActiveAt;
	return {
		clock: { lastActiveAt, lastCheckAt: now },
		idle: !active && now - lastActiveAt >= idleMs,
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
	/** The earliest due tick of a loop that will run, or null. */
	nextLoopAt: () => number | null;
	/** Read on every tick, so a settings change applies within a minute. */
	idleMinutes: () => number;
	log: (line: string) => void;
	now?: () => number;
}

export interface SleepControl {
	stop(): void;
	/** Run one check now (tests drive it). */
	tick(): Promise<void>;
	/** A client attached: counts as work, so the box is held and its window restarts. */
	touch(): void;
}

export async function startSleepControl(
	driver: SleepDriver,
	deps: SleepControlDeps,
): Promise<SleepControl> {
	const now = deps.now ?? Date.now;
	let mode: "hold" | "release" | null = null;
	let armedAt: number | null = null;
	let clock: IdleClock = { lastActiveAt: now(), lastCheckAt: now() };
	let busy = false;
	// A client attached since the last tick. Counted as work once, by the tick.
	let touched = false;

	const apply = async (next: "hold" | "release", nextLoopAt: number | null): Promise<void> => {
		if (next === "release" && nextLoopAt !== null && nextLoopAt !== armedAt) {
			await driver.armWake(nextLoopAt);
			armedAt = nextLoopAt;
		}
		if (next === mode) return;
		await (next === "hold" ? driver.hold() : driver.release());
		if (next === "release" || mode !== null) {
			deps.log(
				next === "release"
					? `[ateam] no agent has worked for ${deps.idleMinutes()} min; letting ${driver.where} sleep`
					: "[ateam] work on this box; holding it awake",
			);
		}
		mode = next;
	};

	const tick = async (): Promise<void> => {
		if (busy) return;
		busy = true;
		try {
			const minutes = deps.idleMinutes();
			const idleMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
			const t = now();
			const working = deps.working() || touched;
			touched = false;
			const step = idleTick(clock, { now: t, working, idleMs });
			clock = step.clock;
			const nextLoopAt = deps.nextLoopAt();
			const canWake = driver.canWakeForLoops;
			await apply(sleepMode({ idle: step.idle, now: t, nextLoopAt, canWake }), nextLoopAt);
		} catch (err) {
			deps.log(`[ateam] sleep control failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			busy = false;
		}
	};

	await tick(); // hold from the start: a fresh engine has no idea how long the box was idle
	const timer = setInterval(() => void tick(), IDLE_CHECK_MS);
	timer.unref?.();
	return {
		stop: () => clearInterval(timer),
		tick,
		// Someone connected, most likely to start a task on a box that just woke.
		// Hold it now and give them a fresh window: an idle connection is not
		// traffic a provider counts, so a released box would sleep under them.
		touch: () => {
			touched = true;
			void tick();
		},
	};
}
