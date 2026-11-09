// The phone's links to its boxes: one WebSocket per saved box, reached, kept and
// retried here, so the board (src/fleet.ts) has every box on it at once. Pure TS,
// with everything it touches passed in, so these rules run under bun test:
//
//   - A box is reached in the background and never woken: dialling a sleeping box
//     over the tailnet leaves it asleep, and its board as last seen stands in. Its
//     card shows it asleep meanwhile, not reached (boxes.ts shownAsleep).
//   - Only someone asking for a box wakes it: a card, opening one of its tasks,
//     starting a task there, its terminal, the Lead on it. A box someone waits on
//     is retried sooner, and woken again once the last wake is stale (REWAKE_MS).
//   - A socket that drops puts the box's last-seen board up, and is tried again.
//   - A box that isn't up keeps its last failure while it's tried again, so what
//     shows it as away (boxes.ts awayOf) doesn't flicker with every try.
//   - Paused (the demo), nothing is reached, and a connect that lands is closed.
//   - Cancel on a card ends its tries where they stand: the card rests as it was
//     before the tap, a socket that answers later is closed, and the box isn't
//     tried again until something asks for it or the app comes to the foreground.
import {
	type BoxSnapshot,
	beginStep,
	type ConnectStep,
	failActive,
	NEEDS_PAIRING,
	reconnectDelay,
	relabelActive,
	WOKEN_CONNECT_MS,
	WOKEN_RETRY_GAP_MS,
	waitingLabel,
} from "@ateam/protocol";
import {
	type BoxLink,
	boxKey,
	CONNECTION_LOST,
	cantWakeReason,
	NEW_LINK,
	NO_PROVIDER_HINT,
	wakesThrough,
} from "./boxes";
import type { Connection } from "./connection";
import type { Fleet } from "./fleet";
import type { SavedConnection } from "./storage";

// How old the last wake can get before a retry for a box someone waits on wakes it
// again. Under the shortest hold a provider's wake gives (Sprites: 5 min,
// packages/protocol/src/wake-sprites.ts).
export const REWAKE_MS = 60_000;
// A box someone waits on is retried 1 s after a failure, doubling up to this.
export const WAITED_RETRY_CAP_MS = 15_000;

// One try at reaching a box. Every wait in it (the wake call, a dial, the gap
// between dials) races `stopped`, so Cancel ends the try at once rather than after
// a wake call (up to a minute) or a dial (up to 15 s) comes back.
const STOP = Symbol("stop");
class Cancelled extends Error {}
interface Attempt {
	cancelled: boolean;
	stopped: Promise<typeof STOP>;
	stop(): void;
}
function newAttempt(): Attempt {
	let fire = () => {};
	const stopped = new Promise<typeof STOP>((r) => {
		fire = () => r(STOP);
	});
	const a: Attempt = {
		cancelled: false,
		stopped,
		stop() {
			a.cancelled = true;
			fire();
		},
	};
	return a;
}

/** Time, as the links see it. Passed in so a test can run it by hand. */
export interface Clock {
	now(): number;
	/** Run `fn` once after `ms`; returns a cancel. */
	after(ms: number, fn: () => void): () => void;
	/** Run `fn` every `ms`; returns a stop. */
	every(ms: number, fn: () => void): () => void;
	sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
	now: () => Date.now(),
	after: (ms, fn) => {
		const t = setTimeout(fn, ms);
		return () => clearTimeout(t);
	},
	every: (ms, fn) => {
		const t = setInterval(fn, ms);
		return () => clearInterval(t);
	},
	sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** How to wake one box through its provider. */
export interface Waker {
	/** The provider's name, for the steps ("Waking the box through Sprites"). */
	label: string;
	/** Wake the box; "running" when it was up already. */
	ensureAwake(): Promise<string>;
}

export interface LinkDeps {
	fleet: Pick<Fleet, "attach" | "detach" | "remove">;
	/** Open a box's socket (src/connection.ts); `onClose` fires when it drops on its own. */
	dial(url: string, onClose: () => void, box: SavedConnection): Promise<Connection>;
	/** The saved boxes, in list order. A key not among them is off the list. */
	boxes(): SavedConnection[];
	/** Whether the privacy disclosure was accepted: nothing is dialled before it is. */
	consented(): boolean;
	/** Show the disclosure; `then` runs once it's accepted. */
	askConsent(then: () => void): void;
	/** How to wake this box; null when it can't be (no provider, no key saved). */
	wakerFor(box: SavedConnection): Promise<Waker | null>;
	/** Someone waits on this box now: its task open, its terminal, the Lead on it, an update. */
	waitedOn(key: string): boolean;
	/** The box's board as last seen, kept now, to stand in while it's away. */
	lastBoard(key: string): BoxSnapshot | null;
	labelOf(key: string): string;
	/** A box from the form answered: put it on the list, in place of `replaces`. */
	save(box: SavedConnection, replaces: string | null | undefined): void;
	/** Before the box shows as connected: read what its banner needs. */
	prepare?(key: string, conn: Connection): Promise<void>;
	/** After it does: the app's own work for a fresh connection. `connect` waits for it. */
	onConnected(key: string, conn: Connection): Promise<void> | void;
	/** Where every link stands, after each change. */
	onLinks(links: Record<string, BoxLink>): void;
	clock?: Clock;
}

export interface LinkOpts {
	/** Someone wants this box now: wake it first if it sleeps. Never a try in the background. */
	wake?: boolean;
	/** From the form: put the box on the list once it answers. */
	save?: boolean;
	/** The saved box the form was editing, replaced by this one. */
	replaces?: string | null;
	/** The provider it is being woken through, while it is (the form's note). */
	onWaking?: (label: string | null) => void;
}

export interface Links {
	/** The one connect path. Resolves whether the box is live after it. */
	connect(box: SavedConnection, opts?: LinkOpts): Promise<boolean>;
	/** Reach a box the app should hold but doesn't, and try again later if it fails. */
	reconnect(key: string, wakeNow?: boolean): Promise<void>;
	/** Something on this box was opened: reach it now, waking it if it sleeps. */
	ensure(key: string | null): void;
	/** Try the box again later: a connect someone asked for failed. */
	retry(key: string): void;
	/** Every saved box, in the background, none of them woken. */
	holdAll(): void;
	/** Back in the foreground: probe each socket, and try every box that isn't up. */
	foreground(): void;
	/** Stop waiting for a box that's being woken. */
	cancel(key: string): void;
	/** Off the list: no more tries, its socket closed, off the board. */
	forget(key: string): void;
	/** Reach nothing (the demo): every socket closed, every try stopped. */
	pause(): void;
	resume(): void;
	/** A connection made elsewhere (the demo's), live from now. */
	adopt(key: string, conn: Connection): void;
	conn(key: string): Connection | undefined;
	liveKeys(): string[];
	get(key: string): BoxLink;
}

export function createLinks(deps: LinkDeps): Links {
	const clock = deps.clock ?? realClock;
	const conns = new Map<string, Connection>();
	// The tries under way, per box: a background one and a tap's can overlap.
	const attempts = new Map<string, Set<Attempt>>();
	const backoff = new Map<string, number>();
	const timers = new Map<string, () => void>();
	const lastWakeAt = new Map<string, number>();
	// Boxes whose wait Cancel stopped: not retried until a try is asked for again.
	const stopped = new Set<string>();
	let state: Record<string, BoxLink> = {};
	let paused = false;

	const boxOf = (key: string): SavedConnection | null =>
		deps.boxes().find((b) => boxKey(b) === key) ?? null;
	const set = (key: string, f: (link: BoxLink) => BoxLink): void => {
		state = { ...state, [key]: f(state[key] ?? NEW_LINK) };
		deps.onLinks(state);
	};
	const clearTimer = (key: string): void => {
		timers.get(key)?.();
		timers.delete(key);
	};

	// Soon, then at a steady pace (reconnectDelay). One someone waits on: sooner.
	function retry(key: string): void {
		if (paused || conns.has(key) || timers.has(key) || stopped.has(key) || !boxOf(key)) return;
		const n = backoff.get(key) ?? 0;
		backoff.set(key, n + 1);
		const delay = deps.waitedOn(key)
			? Math.min(WAITED_RETRY_CAP_MS, 1_000 * 2 ** n)
			: reconnectDelay(n);
		timers.set(
			key,
			clock.after(delay, () => {
				timers.delete(key);
				void reconnect(key);
			}),
		);
	}

	// The first try after a drop skips the wake (a network flip shouldn't wait on the
	// provider); a retry for a box someone waits on wakes it whenever the last wake is
	// stale. Retries stop while the app is in the background (iOS suspends it), so
	// this can't keep a box up on its own.
	async function reconnect(key: string, wakeNow = false): Promise<void> {
		const box = boxOf(key);
		if (!box || paused || !deps.consented() || conns.has(key)) return;
		const stale = clock.now() - (lastWakeAt.get(key) ?? 0) >= REWAKE_MS;
		// A box that said it's always on is woken only when asked for (wakeNow), never
		// by a retry: a tap still can, should it have been put back to sleeping.
		const sleeps = wakesThrough(box) !== undefined;
		const wake = wakeNow || (sleeps && deps.waitedOn(key) && (backoff.get(key) ?? 0) > 0 && stale);
		if (await connect(box, { wake })) return;
		// A locked box waits for a pairing code: trying again changes nothing.
		if (state[key]?.error === NEEDS_PAIRING) return;
		retry(key);
	}

	// A box's socket is gone: its last-seen board takes its place. A socket refused
	// mid-connect closes before the connect has a Connection to give: not a drop.
	function drop(key: string, c: Connection | undefined, again = true): void {
		if (!c || conns.get(key) !== c) return;
		c.close(); // stops its keepalive; the socket itself is gone already
		conns.delete(key);
		const snap = deps.lastBoard(key);
		deps.fleet.detach(key, snap ? { snapshot: snap, label: deps.labelOf(key) } : null);
		set(key, (l) => ({ ...l, state: "down", error: CONNECTION_LOST, asleep: false }));
		backoff.set(key, 0);
		if (again) void reconnect(key);
	}

	async function connect(box: SavedConnection, opts: LinkOpts = {}): Promise<boolean> {
		const key = boxKey(box);
		// Nothing leaves the phone until the disclosure has been accepted. Guarding
		// HERE covers every route in: a card, the form, the launch, the reattach.
		if (!deps.consented()) {
			deps.askConsent(() => void connect(box, opts));
			return false;
		}
		if (paused) return false;
		if (conns.has(key)) {
			// Live already: an edit that kept its address only changes what is saved.
			if (opts.save) deps.save(box, opts.replaces);
			return true;
		}
		// A second try while one runs only if it wakes: the first may not.
		if (attempts.has(key) && !opts.wake) return false;
		clearTimer(key);
		// Someone asked: what comes after it starts from the short end again.
		if (opts.wake) backoff.set(key, 0);
		// A try asked for again (a tap, the foreground) lifts a Cancel's stop.
		stopped.delete(key);
		const attempt = newAttempt();
		const tries = attempts.get(key) ?? new Set<Attempt>();
		tries.add(attempt);
		attempts.set(key, tries);
		// A wait in this try, cut short by Cancel.
		const until = async <T>(p: Promise<T>): Promise<T> => {
			const r = await Promise.race([p, attempt.stopped]);
			if (r === STOP) throw new Cancelled("Cancelled");
			return r;
		};
		// The last failure stays until this try ends: the box is still away meanwhile.
		set(key, (l) => ({ ...l, state: "connecting", asked: opts.wake === true, steps: [] }));
		const step = (f: (steps: ConnectStep[]) => ConnectStep[]) =>
			set(key, (l) => ({ ...l, steps: f(l.steps) }));
		let stopTick: (() => void) | null = null;
		// Shown as one that sleeps: a provider, and the box hasn't said it's always on.
		const wakeable = wakesThrough(box) !== undefined;
		let waker: Waker | null = null;
		let wakeError: string | null = null;
		let cantWake: string | null = null;
		let woke = false;
		try {
			waker = opts.wake ? await until(deps.wakerFor(box)) : null;
			// Asked to wake a box this phone has nothing to wake it with (no provider, or
			// no key or name for it): the one dial below is all there is, so a failure
			// says why, on its card and on whatever waits on it.
			if (opts.wake && !waker && box.sleeps !== false) {
				cantWake = wakeable
					? `${cantWakeReason(box)} Tap the box in Boxes to add it.`
					: `${NO_PROVIDER_HINT} You can set it from the box's card in Boxes.`;
			}
			if (waker) {
				const label = waker.label;
				opts.onWaking?.(label);
				step((s) => beginStep(s, `Waking the box through ${label}`));
				lastWakeAt.set(key, clock.now());
				try {
					// "running": it was up already, so there is nothing to wait for.
					woke = (await until(waker.ensureAwake())) !== "running";
					set(key, (l) => ({ ...l, wakeError: null }));
				} catch (err) {
					if (err instanceof Cancelled) throw err;
					// Still try the box: it may be up, and a key problem must not cost a
					// connection that would have worked.
					wakeError = err instanceof Error ? err.message : String(err);
					const said = `Waking it through ${label} failed: ${wakeError}`;
					set(key, (l) => ({ ...l, wakeError: said }));
					step(failActive);
				} finally {
					opts.onWaking?.(null);
				}
			}
			step((s) => beginStep(s, "Reaching Ateam on the box"));
			// A woken box refuses or ignores the socket until its network and engine are
			// up, which on a Sprite can take minutes after the wake returns. So it gets
			// tries until WOKEN_CONNECT_MS; a box nobody woke gets the one.
			const started = clock.now();
			const deadline = started + (woke ? WOKEN_CONNECT_MS : 0);
			let c: Connection;
			for (;;) {
				try {
					// onClose: it dropped on its own (network flip, box restart, NAT reap).
					const dialing = deps.dial(
						`ws://${box.host}:${box.port || "8787"}`,
						() => drop(key, c),
						box,
					);
					// One that answers after Cancel is closed: nothing waits for it now.
					void dialing.then(
						(late) => {
							if (attempt.cancelled) late.close();
						},
						() => {},
					);
					c = await until(dialing);
					break;
				} catch (err) {
					// A locked box answered: it is awake, and its answer won't change.
					const refused = err instanceof Error && err.message === NEEDS_PAIRING;
					if (err instanceof Cancelled || refused || clock.now() >= deadline) throw err;
					if (!stopTick) {
						const relabel = () =>
							step((s) => relabelActive(s, waitingLabel(clock.now() - started)));
						relabel();
						stopTick = clock.every(1_000, relabel);
					}
					await until(clock.sleep(WOKEN_RETRY_GAP_MS));
				}
			}
			// Another try got there first, or the box was removed (or the demo started)
			// while this one ran.
			if (conns.has(key)) {
				c.close();
				return true;
			}
			if (paused || (!opts.save && !boxOf(key))) {
				c.close();
				return false;
			}
			if (opts.save) deps.save(box, opts.replaces);
			conns.set(key, c);
			deps.fleet.attach(key, c.rpc);
			backoff.set(key, 0);
			await deps.prepare?.(key, c);
			const version = c.info.protocolVersion;
			const minClient = c.info.minClient ?? null;
			set(key, (l) => ({
				state: "live",
				asked: false,
				steps: [],
				error: null,
				asleep: false,
				wakeError: null,
				version,
				minClient,
				gen: l.gen + 1,
			}));
			await deps.onConnected(key, c);
			return true;
		} catch (err) {
			if (paused || conns.has(key)) return conns.has(key);
			// Cancel (or forget) has put the card where it belongs already.
			if (attempt.cancelled) return false;
			// Another try at this box is still running (a tap waking it while a try
			// from the background timed out): the card is that one's to show.
			if ([...tries].some((a) => a !== attempt)) return false;
			step(failActive);
			const msg = err instanceof Error ? err.message : String(err);
			// A locked box's refusal stays exact: the card offers a code field for it.
			const said =
				msg === NEEDS_PAIRING
					? msg
					: wakeError
						? `${msg}. Waking it through ${waker?.label} failed too: ${wakeError}`
						: cantWake && wakeable
							? `${msg}. ${cantWake}`
							: msg;
			set(key, (l) => ({
				...l,
				state: "down",
				error: said,
				// Not answering when nobody woke it is what a box that sleeps does. A
				// box that refused for pairing answered, so it isn't asleep. One someone
				// asked for that this phone can't wake shows why instead.
				asleep: wakeable && waker === null && cantWake === null && msg !== NEEDS_PAIRING,
				...(cantWake && msg !== NEEDS_PAIRING ? { wakeError: cantWake } : {}),
			}));
			return false;
		} finally {
			stopTick?.();
			tries.delete(attempt);
			if (tries.size === 0 && attempts.get(key) === tries) attempts.delete(key);
		}
	}

	function holdAll(): void {
		if (!deps.consented()) {
			deps.askConsent(holdAll);
			return;
		}
		for (const box of deps.boxes()) {
			const key = boxKey(box);
			if (conns.has(key)) continue;
			backoff.set(key, 0);
			void reconnect(key);
		}
	}

	return {
		connect,
		reconnect,
		retry,
		holdAll,
		ensure(key) {
			if (!key || paused || conns.has(key) || !boxOf(key)) return;
			backoff.set(key, 0);
			void reconnect(key, true);
		},
		// The sockets iOS suspended in the background are usually dead with no close
		// event, so each is probed and only redialled if the probe fails. Only a box
		// someone waits on is woken.
		foreground() {
			if (paused) return;
			for (const box of deps.boxes()) {
				const key = boxKey(box);
				if (attempts.has(key)) continue;
				const c = conns.get(key);
				void (async () => {
					if (c) {
						if (await c.ping()) return;
						drop(key, c, false);
					}
					backoff.set(key, 0);
					void reconnect(key, deps.waitedOn(key));
				})();
			}
		},
		cancel(key) {
			const tries = attempts.get(key);
			// Nothing to stop, or it answered: a box that is up stays up.
			if (!tries || conns.has(key)) return;
			for (const a of tries) a.stop();
			attempts.delete(key);
			clearTimer(key);
			stopped.add(key);
			// Back to how it stood before the tap: asleep, or its last failure.
			set(key, (l) => ({ ...l, state: "down", asked: false, steps: [] }));
		},
		forget(key) {
			clearTimer(key);
			backoff.delete(key);
			lastWakeAt.delete(key);
			stopped.delete(key);
			for (const a of attempts.get(key) ?? []) a.stop();
			attempts.delete(key);
			const c = conns.get(key);
			conns.delete(key);
			c?.close();
			deps.fleet.remove(key);
			if (key in state) {
				const { [key]: _gone, ...rest } = state;
				state = rest;
				deps.onLinks(state);
			}
		},
		pause() {
			paused = true;
			for (const stop of timers.values()) stop();
			timers.clear();
			for (const [key, c] of conns) {
				c.close();
				deps.fleet.remove(key);
			}
			conns.clear();
			state = {};
			deps.onLinks(state);
		},
		resume() {
			paused = false;
			holdAll();
		},
		adopt(key, conn) {
			conns.set(key, conn);
			deps.fleet.attach(key, conn.rpc);
			set(key, () => ({
				...NEW_LINK,
				state: "live",
				version: conn.info.protocolVersion,
				minClient: conn.info.minClient ?? null,
				gen: 1,
			}));
		},
		conn: (key) => conns.get(key),
		liveKeys: () => [...conns.keys()],
		get: (key) => state[key] ?? NEW_LINK,
	};
}
