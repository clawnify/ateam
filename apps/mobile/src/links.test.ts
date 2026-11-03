import { expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "@ateam/protocol";
import { awayOf, type BoxLink, boxKey } from "./boxes";
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
