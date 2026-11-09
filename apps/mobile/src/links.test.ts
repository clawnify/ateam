import { expect, test } from "bun:test";
import { NEEDS_PAIRING, PROTOCOL_VERSION, WOKEN_CONNECT_MS } from "@ateam/protocol";
import { awayOf, type BoxLink, boxKey, NO_PROVIDER_HINT } from "./boxes";
import type { Connection } from "./connection";
import { type Clock, createLinks, type LinkDeps, REWAKE_MS } from "./links";
import type { SavedConnection } from "./storage";

// Lets every promise chain started so far run to its next real wait.
const settle = async () => {
	for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

// Time run by hand: `advance` fires what comes due, in order, settling after each.
function fakeClock() {
	let t = 1_000_000;
	let timers: { id: number; at: number; fn: () => void; every?: number }[] = [];
	let nextId = 1;
	const add = (ms: number, fn: () => void, every?: number) => {
		const id = nextId++;
		timers.push({ id, at: t + ms, fn, every });
		return () => {
			timers = timers.filter((x) => x.id !== id);
		};
	};
	const clock: Clock = {
		now: () => t,
		after: (ms, fn) => add(ms, fn),
		every: (ms, fn) => add(ms, fn, ms),
		sleep: (ms) => new Promise((r) => add(ms, () => r())),
	};
	const advance = async (ms: number) => {
		const end = t + ms;
		for (;;) {
			const due = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			t = due.at;
			if (due.every) due.at += due.every;
			else timers = timers.filter((x) => x.id !== due.id);
			due.fn();
			await settle();
		}
		t = end;
		await settle();
	};
	return { clock, advance };
}

function fakeConn(): Connection & { closed: boolean } {
	const c = {
		closed: false,
		api: {},
		rpc: { call: async () => undefined, on: () => () => {} },
		info: { protocolVersion: PROTOCOL_VERSION, agents: [] },
		skewed: false,
		ping: async () => true,
		update: async () => ({ started: true, logPath: "" }),
		box: { repos: async () => [], clone: async () => ({}) },
		lead: {},
		close() {
			c.closed = true;
		},
	};
	return c as unknown as Connection & { closed: boolean };
}

const plain: SavedConnection = { host: "100.1.1.1", port: "8787" };
const sleepy: SavedConnection = {
	host: "100.2.2.2",
	port: "8787",
	provider: { id: "sprites", box: { machine: "m" } },
};
// A boxd machine reached over SSH: boxd's gateway wakes it on connect (providers.ts).
const sshBoxd: SavedConnection = {
	host: "m.boxd.sh",
	port: "12836",
	ssh: { user: "boxd", identity: "id", auth: "password", hostKey: "ssh-ed25519 AAAA" },
	provider: { id: "boxd", box: { machine: "m" } },
};
const key = boxKey;

function harness(over: Partial<LinkDeps> = {}) {
	const fc = fakeClock();
	const calls: {
		onClose: () => void;
		resolve: (c: Connection) => void;
		reject: (e: Error) => void;
	}[] = [];
	const log: string[] = [];
	const wakes: string[] = [];
	const waited = new Set<string>();
	let list = [plain, sleepy];
	let links: Record<string, BoxLink> = {};
	const deps: LinkDeps = {
		fleet: {
			attach: (k) => void log.push(`attach ${k}`),
			detach: (k, last) => void log.push(`detach ${k} ${last ? "kept" : "none"}`),
			remove: (k) => void log.push(`remove ${k}`),
		},
		dial: (_url, onClose) =>
			new Promise<Connection>((resolve, reject) => calls.push({ onClose, resolve, reject })),
		boxes: () => list,
		consented: () => true,
		askConsent: () => {},
		wakerFor: async (box) =>
			box.provider
				? {
						label: "Sprites",
						ensureAwake: async () => {
							wakes.push(key(box));
							return "running";
						},
					}
				: null,
		waitedOn: (k) => waited.has(k),
		lastBoard: () => ({ at: 1, projects: [], tasks: {}, loops: [] }),
		labelOf: (k) => k,
		save: () => {},
		onConnected: () => {},
		onLinks: (next) => {
			links = next;
		},
		clock: fc.clock,
		...over,
	};
	return {
		links: createLinks(deps),
		fc,
		calls,
		log,
		wakes,
		waited,
		state: () => links,
		setBoxes: (next: SavedConnection[]) => {
			list = next;
		},
	};
}

test("boxes are reached in the background without being woken, and one that doesn't answer reads as asleep", async () => {
	const h = harness();
	h.links.holdAll();
	await settle();
	expect(h.calls).toHaveLength(2);
	expect(h.wakes).toEqual([]);
	h.calls[1]?.reject(new Error("timed out"));
	await settle();
	expect(h.state()[key(sleepy)]).toMatchObject({ state: "down", asleep: true });
	expect(awayOf(h.state()[key(sleepy)])).toBe("asleep");
	// Tried again later, and still not woken.
	await h.fc.advance(5_000);
	expect(h.calls).toHaveLength(3);
	expect(h.wakes).toEqual([]);
});

test("a box someone waits on is woken, and woken again only once the last wake is stale", async () => {
	const h = harness({ dial: () => Promise.reject(new Error("timed out")) });
	h.waited.add(key(sleepy));
	h.links.ensure(key(sleepy));
	await settle();
	expect(h.wakes).toEqual([key(sleepy)]);
	// Retried every 1, 2, 4, 8, then 15 s: none of those wakes it again...
	await h.fc.advance(REWAKE_MS - 1_000);
	expect(h.wakes).toHaveLength(1);
	// ...until the retry that finds the last wake stale.
	await h.fc.advance(2_000);
	expect(h.wakes).toHaveLength(2);
});

test("a box asked for that this phone can't wake says why, rather than reading as asleep", async () => {
	// A Sprite whose token isn't on this phone: there is no waker for it.
	const h = harness({ wakerFor: async () => null });
	h.waited.add(key(sleepy));
	h.links.ensure(key(sleepy));
	await settle();
	h.calls[0]?.reject(new Error("Timed out reaching the box"));
	await settle();
	expect(h.state()[key(sleepy)]).toMatchObject({
		state: "down",
		asleep: false,
		error:
			"Timed out reaching the box. This phone has no Sprites API token to wake it with. Tap the box in Boxes to add it.",
		wakeError:
			"This phone has no Sprites API token to wake it with. Tap the box in Boxes to add it.",
	});
	// In the background it is asleep, as before: nobody asked, so nothing to explain.
	const bg = harness({ wakerFor: async () => null });
	bg.links.holdAll();
	await settle();
	bg.calls[1]?.reject(new Error("timed out"));
	await settle();
	expect(bg.state()[key(sleepy)]).toMatchObject({ state: "down", asleep: true, wakeError: null });
});

test("a box with no name at its provider says the name is missing", async () => {
	const unnamed: SavedConnection = { ...sleepy, provider: { id: "sprites", box: { machine: "" } } };
	const h = harness({ wakerFor: async () => null });
	h.setBoxes([unnamed]);
	void h.links.connect(unnamed, { wake: true });
	await settle();
	h.calls[0]?.reject(new Error("Timed out reaching the box"));
	await settle();
	expect(h.state()[key(unnamed)]?.wakeError).toBe(
		"This phone doesn't have its name at Sprites, so it can't wake it. Tap the box in Boxes to add it.",
	);
});

test("a box with no provider that doesn't answer when asked for says how to make it wakeable", async () => {
	const h = harness();
	h.waited.add(key(plain));
	h.links.ensure(key(plain));
	await settle();
	h.calls[0]?.reject(new Error("Timed out reaching the box"));
	await settle();
	// The card keeps the plain failure (its tray says what to do); what waits on it says why.
	expect(h.state()[key(plain)]).toMatchObject({
		state: "down",
		asleep: false,
		error: "Timed out reaching the box",
		wakeError: `${NO_PROVIDER_HINT} You can set it from the box's card in Boxes.`,
	});
	// A box nobody asked for has nobody waiting to tell.
	const bg = harness();
	bg.links.holdAll();
	await settle();
	bg.calls[0]?.reject(new Error("Timed out reaching the box"));
	await settle();
	expect(bg.state()[key(plain)]).toMatchObject({ state: "down", wakeError: null });
});

test("a box that says it's always on reads as offline, not asleep, and asks for no key", async () => {
	const always: SavedConnection = { ...sleepy, sleeps: false };
	// No key for it on this phone: a tap dials, fails plainly, and asks for nothing.
	const h = harness({ wakerFor: async () => null });
	h.setBoxes([always]);
	void h.links.connect(always, { wake: true });
	await settle();
	h.calls[0]?.reject(new Error("Timed out reaching the box"));
	await settle();
	expect(h.state()[key(always)]).toMatchObject({
		state: "down",
		asleep: false,
		error: "Timed out reaching the box",
		wakeError: null,
	});
	expect(awayOf(h.state()[key(always)])).toBe("offline");
	// With a key, a tap still wakes it: it may have been put back to sleeping since.
	const k = harness();
	k.setBoxes([always]);
	void k.links.connect(always, { wake: true });
	await settle();
	expect(k.wakes).toEqual([key(always)]);
	// A retry for it never does, even with its task open.
	const r = harness({ dial: () => Promise.reject(new Error("timed out")) });
	r.setBoxes([always]);
	r.waited.add(key(always));
	void r.links.reconnect(key(always));
	await r.fc.advance(REWAKE_MS * 3);
	expect(r.wakes).toEqual([]);
});

test("a socket refused before the connect resolves is a failed try, not a dropped box", async () => {
	const h = harness();
	const tried = h.links.connect(plain);
	h.calls[0]?.onClose(); // the socket closes before the handshake fails
	h.calls[0]?.reject(new Error("RPC connection closed"));
	expect(await tried).toBe(false);
	expect(h.log).toEqual([]);
	expect(h.state()[key(plain)]).toMatchObject({
		state: "down",
		error: "RPC connection closed",
		asleep: false,
	});
});

test("a dropped box puts its last-seen board up, reads as offline, and is dialled again at once", async () => {
	const h = harness();
	const tried = h.links.connect(plain);
	const c = fakeConn();
	h.calls[0]?.resolve(c);
	expect(await tried).toBe(true);
	expect(h.log).toEqual([`attach ${key(plain)}`]);
	expect(h.state()[key(plain)]?.gen).toBe(1);
	h.calls[0]?.onClose();
	expect(c.closed).toBe(true);
	expect(h.log).toEqual([`attach ${key(plain)}`, `detach ${key(plain)} kept`]);
	await settle();
	expect(h.calls).toHaveLength(2);
	// Away while that try runs: the marker doesn't flicker off with every try.
	expect(h.state()[key(plain)]?.state).toBe("connecting");
	expect(awayOf(h.state()[key(plain)])).toBe("offline");
	h.calls[1]?.resolve(fakeConn());
	await settle();
	expect(awayOf(h.state()[key(plain)])).toBeNull();
	expect(h.state()[key(plain)]?.gen).toBe(2);
});

test("paused (the demo), nothing is reached: a connect that lands is closed and no try fires", async () => {
	const h = harness();
	const tried = h.links.connect(plain);
	h.links.pause();
	const c = fakeConn();
	h.calls[0]?.resolve(c);
	expect(await tried).toBe(false);
	expect(c.closed).toBe(true);
	expect(h.log).toEqual([]);
	h.links.holdAll();
	h.links.ensure(key(sleepy));
	await h.fc.advance(120_000);
	expect(h.calls).toHaveLength(1);
	expect(h.links.liveKeys()).toEqual([]);
	// Resumed, every box is reached again.
	h.links.resume();
	await settle();
	expect(h.calls).toHaveLength(3);
});

test("a box taken off the list while it's reached is closed when it answers, never put on the board", async () => {
	const h = harness();
	const tried = h.links.connect(plain);
	h.setBoxes([sleepy]);
	const c = fakeConn();
	h.calls[0]?.resolve(c);
	expect(await tried).toBe(false);
	expect(c.closed).toBe(true);
	expect(h.log).toEqual([]);
});

test("forgetting a box closes its socket, stops its tries and takes it off the board", async () => {
	const h = harness();
	const tried = h.links.connect(plain);
	const c = fakeConn();
	h.calls[0]?.resolve(c);
	await tried;
	h.links.forget(key(plain));
	expect(c.closed).toBe(true);
	expect(h.log).toContain(`remove ${key(plain)}`);
	expect(h.state()[key(plain)]).toBeUndefined();
	h.setBoxes([sleepy]);
	await h.fc.advance(120_000);
	expect(h.calls).toHaveLength(1);
});

test("nothing is dialled before the disclosure is accepted", async () => {
	let agreed = false;
	let pending: (() => void) | null = null;
	const h = harness({
		consented: () => agreed,
		askConsent: (then) => {
			pending = then;
		},
	});
	h.links.holdAll();
	expect(h.calls).toHaveLength(0);
	agreed = true;
	(pending as (() => void) | null)?.();
	await settle();
	expect(h.calls).toHaveLength(2);
});

test("a tap while a background try runs goes ahead and wakes the box; the try that lands later is closed", async () => {
	const h = harness();
	h.links.holdAll();
	await settle();
	const tap = h.links.connect(sleepy, { wake: true });
	await settle();
	expect(h.wakes).toEqual([key(sleepy)]);
	expect(h.calls).toHaveLength(3);
	h.calls[2]?.resolve(fakeConn());
	expect(await tap).toBe(true);
	const late = fakeConn();
	h.calls[1]?.resolve(late);
	await settle();
	expect(late.closed).toBe(true);
	expect(h.log.filter((l) => l === `attach ${key(sleepy)}`)).toHaveLength(1);
});

test("a background try that times out while a tap wakes the box leaves the tap's steps on the card", async () => {
	const h = harness();
	h.links.holdAll();
	await settle();
	const tap = h.links.connect(sleepy, { wake: true });
	await settle();
	expect(h.calls).toHaveLength(3);
	// The try from the background gives up while the tap's dial still waits.
	h.calls[1]?.reject(new Error("connection timed out after 15000ms"));
	await settle();
	const during = h.state()[key(sleepy)];
	expect(during).toMatchObject({ state: "connecting", asked: true, error: null, asleep: false });
	expect(during?.steps.at(-1)).toMatchObject({
		label: "Reaching Ateam on the box",
		status: "active",
	});
	h.calls[2]?.resolve(fakeConn());
	expect(await tap).toBe(true);
	expect(h.state()[key(sleepy)]).toMatchObject({ state: "live" });
});

test("back in the foreground, a dead socket is dropped and redialled, a live one left alone", async () => {
	const h = harness();
	const one = h.links.connect(plain);
	const alive = fakeConn();
	h.calls[0]?.resolve(alive);
	await one;
	const two = h.links.connect(sleepy);
	const dead = fakeConn();
	dead.ping = async () => false;
	h.calls[1]?.resolve(dead);
	await two;
	h.links.foreground();
	await settle();
	expect(alive.closed).toBe(false);
	expect(dead.closed).toBe(true);
	expect(h.calls).toHaveLength(3);
	// Nobody waits on it, so the redial doesn't wake it.
	expect(h.wakes).toEqual([]);
});

test("Cancel during the wake ends the try at once: the card rests, the tap hears no, the box is never dialled", async () => {
	let woken: (s: string) => void = () => {};
	const h = harness({
		wakerFor: async () => ({
			label: "Sprites",
			ensureAwake: () =>
				new Promise<string>((r) => {
					woken = r;
				}),
		}),
	});
	const tap = h.links.connect(sleepy, { wake: true });
	await settle();
	expect(h.state()[key(sleepy)]).toMatchObject({ state: "connecting", asked: true });
	expect(h.state()[key(sleepy)]?.steps).toHaveLength(1);
	h.links.cancel(key(sleepy));
	// Said on the card right away, not once the wake call comes back.
	expect(h.state()[key(sleepy)]).toMatchObject({ state: "down", asked: false, steps: [] });
	expect(await tap).toBe(false);
	woken("woken");
	await h.fc.advance(10_000);
	expect(h.calls).toHaveLength(0);
	expect(h.state()[key(sleepy)]?.state).toBe("down");
});

test("Cancel while the box is dialled: the socket that answers later is closed, never put on the board", async () => {
	const h = harness();
	const tap = h.links.connect(sleepy, { wake: true });
	await settle();
	expect(h.calls).toHaveLength(1);
	h.links.cancel(key(sleepy));
	expect(await tap).toBe(false);
	const late = fakeConn();
	h.calls[0]?.resolve(late);
	await settle();
	expect(late.closed).toBe(true);
	expect(h.log).toEqual([]);
	expect(h.links.liveKeys()).toEqual([]);
	expect(h.state()[key(sleepy)]?.state).toBe("down");
});

test("a woken box that Cancel stopped waiting for isn't tried again until something asks for it", async () => {
	let dials = 0;
	const dial = () => {
		dials++;
		return Promise.reject(new Error("timed out"));
	};
	const h = harness({
		dial,
		wakerFor: async () => ({ label: "Sprites", ensureAwake: async () => "woken" }),
	});
	const tap = h.links.connect(sleepy, { wake: true });
	await settle();
	expect(dials).toBe(1);
	// Between two tries of the woken box: Cancel ends the gap too.
	h.links.cancel(key(sleepy));
	expect(await tap).toBe(false);
	// What a card's tap does after a connect that failed.
	h.links.retry(key(sleepy));
	await h.fc.advance(WOKEN_CONNECT_MS + 120_000);
	expect(dials).toBe(1);
	expect(h.state()[key(sleepy)]).toMatchObject({ state: "down", steps: [] });
	// Asked for again, it is reached again.
	h.links.ensure(key(sleepy));
	await settle();
	expect(dials).toBe(2);
});

test("a box locked to other devices says so and isn't dialled again: it waits for a code", async () => {
	let dials = 0;
	const h = harness({
		dial: () => {
			dials++;
			return Promise.reject(new Error(NEEDS_PAIRING));
		},
	});
	h.setBoxes([plain]);
	h.links.holdAll();
	await settle();
	expect(h.state()[key(plain)]).toMatchObject({ state: "down", error: NEEDS_PAIRING });
	expect(dials).toBe(1);
	await h.fc.advance(300_000);
	expect(dials).toBe(1);
});

test("a locked box that sleeps says it needs pairing, not that it's asleep", async () => {
	const h = harness({ dial: () => Promise.reject(new Error(NEEDS_PAIRING)) });
	h.setBoxes([sleepy]);
	h.links.holdAll();
	await settle();
	expect(h.state()[key(sleepy)]).toMatchObject({
		state: "down",
		error: NEEDS_PAIRING,
		asleep: false,
	});
});

test("a woken box that refuses for pairing says so at once instead of trying for minutes", async () => {
	let dials = 0;
	const h = harness({
		dial: () => {
			dials++;
			return Promise.reject(new Error(NEEDS_PAIRING));
		},
		// Asleep until this wake: the try would keep dialling until WOKEN_CONNECT_MS.
		wakerFor: async () => ({ label: "Sprites", ensureAwake: async () => "started" }),
	});
	h.setBoxes([sleepy]);
	expect(await h.links.connect(sleepy, { wake: true })).toBe(false);
	expect(dials).toBe(1);
	expect(h.state()[key(sleepy)]).toMatchObject({
		state: "down",
		error: NEEDS_PAIRING,
		asleep: false,
	});
});

test("a box that connecting wakes is never dialled in the background, and a tap dials it with no key", async () => {
	const h = harness({ wakerFor: async () => null });
	h.setBoxes([sshBoxd]);
	h.links.holdAll();
	await settle();
	// The dial would wake it: the card rests asleep instead.
	expect(h.calls).toHaveLength(0);
	expect(h.state()[key(sshBoxd)]).toMatchObject({ state: "down", asleep: true });
	// Coming back to the foreground, and time passing, don't dial it either.
	h.links.foreground();
	await settle();
	await h.fc.advance(120_000);
	expect(h.calls).toHaveLength(0);
	// A tap dials it with no boxd key, since connecting is its wake.
	const tapped = h.links.connect(sshBoxd, { wake: true });
	await settle();
	expect(h.calls).toHaveLength(1);
	h.calls[0]?.reject(new Error("refused"));
	expect(await tapped).toBe(false);
	// Woken by that dial, so its failure is a failure: not asleep, and no key asked for.
	expect(h.state()[key(sshBoxd)]).toMatchObject({
		state: "down",
		asleep: false,
		error: "refused",
		wakeError: null,
	});
});

test("a box that connecting wakes is dialled once something on it is opened", async () => {
	const h = harness({ wakerFor: async () => null });
	h.setBoxes([sshBoxd]);
	h.links.ensure(key(sshBoxd));
	await settle();
	expect(h.calls).toHaveLength(1);
});
