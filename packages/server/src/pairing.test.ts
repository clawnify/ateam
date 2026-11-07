// The lock on a box's network port: the pairing store (pairing.ts) and how one
// connection is gated by it (rpc.ts serveRpc).
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CH,
	type ClientFrame,
	NEEDS_PAIRING,
	type PairingGrantDTO,
	type PairingInviteDTO,
	type ProviderReport,
	type ServerFrame,
} from "@ateam/protocol";
import type { Dispatcher } from "./dispatcher";
import type { Engine } from "./engine";
import { CODE_TTL_MS, PAIRINGS_FILE, Pairings } from "./pairing";
import {
	BOX_REFUSED,
	LinkLimiter,
	LiveConnections,
	type PairingGuard,
	RedeemLimiter,
	serveRpc,
} from "./rpc";

const dir = () => mkdtempSync(join(tmpdir(), "pairing-"));

describe("the pairing store", () => {
	it("is open until locked; locking pairs the device that asked", () => {
		const p = new Pairings(dir());
		expect(p.locked()).toBe(false);
		const grant = p.lock("MacBook", "desktop");
		expect(p.locked()).toBe(true);
		expect(p.verify(grant.token)?.id).toBe(grant.device.id);
		expect(p.status(null).devices.map((d) => d.label)).toEqual(["MacBook"]);
	});

	it("trades a code, once, for a token of the device's own, and keeps only hashes", () => {
		const d = dir();
		const p = new Pairings(d);
		const { code } = p.invite();
		// As typed off a screen: lower case, with the dash it was shown with.
		const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
		const grant = p.redeem(typed, "iPhone", "phone");
		expect(grant.device).toMatchObject({ label: "iPhone", kind: "phone" });
		expect(p.verify(grant.token)?.label).toBe("iPhone");
		expect(() => p.redeem(code, "Again", "phone")).toThrow("isn't valid");
		const file = readFileSync(join(d, PAIRINGS_FILE), "utf8");
		expect(file).not.toContain(grant.token);
		expect(file).not.toContain(code);
		expect(statSync(join(d, PAIRINGS_FILE)).mode & 0o777).toBe(0o600);
	});

	it("refuses a code after ten minutes", () => {
		let t = 1_000_000;
		const p = new Pairings(dir(), () => t);
		const { code } = p.invite();
		t += CODE_TTL_MS + 1;
		expect(() => p.redeem(code, "Late", "phone")).toThrow("expired");
	});

	it("forgets a revoked device's token", () => {
		const p = new Pairings(dir());
		const grant = p.lock("MacBook", "desktop");
		expect(p.revoke(grant.device.id)).toBe(true);
		expect(p.verify(grant.token)).toBeNull();
		expect(p.revoke(grant.device.id)).toBe(false);
	});

	it("pairs a device by its token's hash, leaving the box open or locked as it was", () => {
		const d = dir();
		const p = new Pairings(d);
		const token = "t".repeat(43);
		const hash = new Bun.CryptoHasher("sha256").update(token).digest("hex");
		expect(p.addDevice(hash, "iPhone", "phone")).toBe(true);
		expect(p.locked()).toBe(false);
		expect(p.verify(token)).toMatchObject({ label: "iPhone", kind: "phone" });
		// Again is a no-op, not a second device.
		expect(p.addDevice(hash, "iPhone", "phone")).toBe(false);
		expect(p.status(null).devices).toHaveLength(1);
		// A locked box stays locked, and the device gets in.
		const q = new Pairings(dir());
		q.lockIfNew();
		q.addDevice(hash, "iPhone", "phone");
		expect(q.locked()).toBe(true);
		expect(q.verify(token)?.label).toBe("iPhone");
		expect(readFileSync(join(d, PAIRINGS_FILE), "utf8")).not.toContain(token);
	});

	it("refuses anything but a sha256 hex digest as a device's hash", () => {
		const p = new Pairings(dir());
		expect(() => p.addDevice("abc", "x", "phone")).toThrow("token hash");
		expect(() => p.addDevice("A".repeat(64), "x", "phone")).toThrow("token hash");
	});

	it("fails closed on a damaged file", () => {
		const d = dir();
		writeFileSync(join(d, PAIRINGS_FILE), "{ not json");
		const p = new Pairings(d);
		expect(p.locked()).toBe(true);
		expect(p.verify("x".repeat(43))).toBeNull();
	});
});

// ---- one connection, gated ----

function fakeEngine() {
	const listeners = new Map<string, Set<(p: unknown) => void>>();
	const engine = {
		on: (event: string, l: (p: unknown) => void) => {
			const set = listeners.get(event) ?? new Set();
			set.add(l);
			listeners.set(event, set);
			return () => set.delete(l);
		},
	} as unknown as Engine;
	const emit = (event: string, payload: unknown) => {
		for (const l of listeners.get(event) ?? []) l(payload);
	};
	const calls: { method: string; ctx?: { linkName?: string | null } }[] = [];
	const dispatcher = {
		methods: [],
		handle: async (method: string, _args: unknown[], ctx?: { linkName?: string | null }) => {
			calls.push({ method, ctx });
			return method === CH.systemHello ? { protocolVersion: 29, agents: [] } : `did ${method}`;
		},
		release: () => {},
	} as unknown as Dispatcher;
	return { engine, emit, dispatcher, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 2));

function connect(
	box: ReturnType<typeof fakeEngine>,
	guard: PairingGuard,
	trusted = false,
	extra: { wsAddr?: string | null; provider?: ProviderReport | null } = {},
) {
	const sent: ServerFrame[] = [];
	let onFrame: (f: ClientFrame) => void = () => {};
	let closed = false;
	serveRpc(
		box.engine,
		box.dispatcher,
		{
			send: (f) => sent.push(f),
			onFrame: (h) => {
				onFrame = h;
			},
			close: () => {
				closed = true;
			},
		},
		[],
		{ trusted, pairing: guard, ...extra },
	);
	let n = 0;
	const call = async (method: string, ...args: unknown[]) => {
		const id = ++n;
		onFrame({ t: "req", id, method, args });
		for (let i = 0; i < 50; i++) {
			const res = sent.find((f) => f.t === "res" && f.id === id);
			if (res?.t === "res") {
				if (!res.ok) throw new Error(res.error);
				return res.result;
			}
			await tick();
		}
		throw new Error(`no reply to ${method}`);
	};
	const events = () => sent.filter((f) => f.t === "evt").length;
	const names = () => sent.flatMap((f) => (f.t === "evt" ? [f.event] : []));
	return { call, events, names, closed: () => closed };
}

function guardIn(d = dir()): PairingGuard {
	return { store: new Pairings(d), live: new LiveConnections(), limiter: new RedeemLimiter() };
}

describe("a connection to a box's network port", () => {
	it("on an open box, works as before and says it is open", async () => {
		const box = fakeEngine();
		const c = connect(box, guardIn());
		expect(await c.call(CH.systemHello)).toMatchObject({ pairing: { state: "open" } });
		expect(await c.call("tasks:list")).toBe("did tasks:list");
		box.emit("taskUpdated", { id: "t" });
		expect(c.events()).toBe(1);
	});

	it("on a locked box, gets no events and no calls until it is paired", async () => {
		const box = fakeEngine();
		const guard = guardIn();
		const owner = guard.store.lock("MacBook", "desktop");
		const c = connect(box, guard);
		box.emit("ptyData", { data: "secret output" });
		expect(c.events()).toBe(0);
		expect(await c.call(CH.systemHello)).toMatchObject({ pairing: { state: "needed" } });
		await expect(c.call("tasks:list")).rejects.toThrow(NEEDS_PAIRING);
		await expect(c.call(CH.pairingInvite)).rejects.toThrow(NEEDS_PAIRING);
		// The paired device's token lets it in, events and all.
		expect(await c.call(CH.systemHello, { token: owner.token })).toMatchObject({
			pairing: { state: "paired", device: owner.device.id },
		});
		box.emit("ptyData", { data: "now visible" });
		expect(c.events()).toBe(1);
		expect(await c.call("tasks:list")).toBe("did tasks:list");
	});

	it("pairs a new device with a code from a paired one", async () => {
		const box = fakeEngine();
		const guard = guardIn();
		const owner = guard.store.lock("MacBook", "desktop");
		const mac = connect(box, guard);
		await mac.call(CH.systemHello, { token: owner.token });
		const { code } = (await mac.call(CH.pairingInvite)) as PairingInviteDTO;
		const phone = connect(box, guard);
		const grant = (await phone.call(CH.pairingRedeem, {
			code,
			label: "iPhone",
			kind: "phone",
		})) as PairingGrantDTO;
		expect(await phone.call("tasks:list")).toBe("did tasks:list");
		const next = connect(box, guard);
		expect(await next.call(CH.systemHello, { token: grant.token })).toMatchObject({
			pairing: { state: "paired" },
		});
	});

	it("gives no codes on an open box, so nothing can pair before the owner locks it", async () => {
		const box = fakeEngine();
		const guard = guardIn();
		const c = connect(box, guard);
		await expect(c.call(CH.pairingInvite)).rejects.toThrow("Lock the box first");
		// Over SSH it may: that is the owner.
		const ssh = connect(box, guard, true);
		expect(await ssh.call(CH.pairingInvite)).toMatchObject({ code: expect.any(String) });
	});

	it("from another box, gets task updates only, and may only read the board and send messages", async () => {
		const box = fakeEngine();
		const c = connect(box, guardIn());
		await c.call(CH.systemHello, { link: true });
		box.emit("ptyData", { terminalId: "x", data: "secret" });
		box.emit("loopsUpdated", []);
		box.emit("taskUpdated", { id: "t" });
		box.emit("taskRemoved", "t");
		expect(c.names()).toEqual(["taskUpdated", "taskRemoved"]);
		expect(await c.call(CH.tasksList, "p")).toBe(`did ${CH.tasksList}`);
		expect(await c.call(CH.peersSendFromBox, {})).toBe(`did ${CH.peersSendFromBox}`);
		await expect(c.call(CH.ptyWrite, "x", "rm -rf ~")).rejects.toThrow(BOX_REFUSED);
		await expect(c.call(CH.gitPush, {})).rejects.toThrow(BOX_REFUSED);
		await expect(c.call(CH.linksSet, {})).rejects.toThrow(BOX_REFUSED);
		// Never with the user's weight: not as the Lead, not answering for them.
		await expect(c.call(CH.peersSendFromLead, { taskId: "t", body: "x" })).rejects.toThrow(
			BOX_REFUSED,
		);
		await expect(c.call(CH.tasksAnswerQuestion, { taskId: "t" })).rejects.toThrow(BOX_REFUSED);
	});

	it("paired as a box, is held to that whatever its hello says", async () => {
		const box = fakeEngine();
		const guard = guardIn();
		const mac = connect(box, guard);
		await mac.call(CH.pairingLock, { label: "Mac", kind: "desktop" });
		const { code } = (await mac.call(CH.pairingInvite)) as { code: string };
		const other = connect(box, guard);
		const grant = (await other.call(CH.pairingRedeem, { code, label: "probe", kind: "box" })) as {
			token: string;
		};
		box.emit("ptyData", { terminalId: "x", data: "secret" });
		box.emit("taskUpdated", { id: "t" });
		expect(other.names()).toEqual(["taskUpdated"]);
		await expect(other.call(CH.ptyWrite, "x", "ls")).rejects.toThrow(BOX_REFUSED);
		// Back later with its token, saying nothing about being a link.
		const again = connect(box, guard);
		expect(await again.call(CH.systemHello, { token: grant.token })).toMatchObject({
			pairing: { state: "paired" },
		});
		await expect(again.call(CH.ptyWrite, "x", "ls")).rejects.toThrow(BOX_REFUSED);
		box.emit("ptyData", { terminalId: "x", data: "secret" });
		expect(again.names()).toEqual([]);
		// The Mac that paired it is untouched.
		expect(await mac.call(CH.ptyWrite, "x", "ls")).toBe(`did ${CH.ptyWrite}`);
	});

	it("names what a box link hands over by its pairing, and caps the link as a whole", async () => {
		const box = fakeEngine();
		const guard: PairingGuard = { ...guardIn(), fromLinks: new LinkLimiter(2) };
		const mac = connect(box, guard);
		await mac.call(CH.pairingLock, { label: "Mac", kind: "desktop" });
		const { code } = (await mac.call(CH.pairingInvite)) as { code: string };
		const probe = connect(box, guard);
		await probe.call(CH.pairingRedeem, { code, label: "probe", kind: "box" });
		const claim = {
			to: "t",
			body: "x",
			from: { box: "mallory", taskId: "a", name: "b", agent: "c" },
		};
		await probe.call(CH.peersSendFromBox, claim);
		expect(box.calls.at(-1)).toMatchObject({
			method: CH.peersSendFromBox,
			ctx: { linkName: "probe" },
		});
		// Its own senders' caps can't hold a box that names new ones: this one does.
		await probe.call(CH.peersSendFromBox, claim);
		await expect(probe.call(CH.peersSendFromBox, claim)).rejects.toThrow("rate limit");
	});

	it("says where the box listens, for other boxes to link to", async () => {
		const box = fakeEngine();
		const c = connect(box, guardIn(), false, { wsAddr: "100.64.0.7:8787" });
		expect(await c.call(CH.systemHello)).toMatchObject({ wsAddr: "100.64.0.7:8787" });
	});

	it("says which provider puts the box to sleep, so a client that added it by address can wake it", async () => {
		const provider = { id: "sprites", box: { machine: "ateam-box" }, sleeps: true };
		const c = connect(fakeEngine(), guardIn(), false, { provider });
		expect(await c.call(CH.systemHello)).toMatchObject({ provider });
		const none = connect(fakeEngine(), guardIn(), false, { provider: null });
		expect(await none.call(CH.systemHello)).toMatchObject({ provider: null });
		const unknown = connect(fakeEngine(), guardIn());
		expect(await unknown.call(CH.systemHello)).not.toHaveProperty("provider");
		// A locked box tells only a device it has admitted.
		const guard = guardIn();
		const owner = guard.store.lock("MacBook", "desktop");
		const stranger = connect(fakeEngine(), guard, false, { provider });
		expect(await stranger.call(CH.systemHello)).not.toHaveProperty("provider");
		expect(await stranger.call(CH.systemHello, { token: owner.token })).toMatchObject({ provider });
	});

	it("over SSH, is never gated", async () => {
		const box = fakeEngine();
		const guard = guardIn();
		guard.store.lock("MacBook", "desktop");
		const ssh = connect(box, guard, true);
		expect(await ssh.call(CH.systemHello)).toMatchObject({ pairing: { state: "trusted" } });
		expect(await ssh.call(CH.pairingInvite)).toMatchObject({ code: expect.any(String) });
	});

	it("locking drops every connection that was only in because the box was open", async () => {
		const box = fakeEngine();
		const guard = guardIn();
		const other = connect(box, guard);
		const ssh = connect(box, guard, true);
		const mac = connect(box, guard);
		const grant = (await mac.call(CH.pairingLock, {
			label: "MacBook",
			kind: "desktop",
		})) as PairingGrantDTO;
		expect(grant.device.label).toBe("MacBook");
		expect(other.closed()).toBe(true);
		expect(ssh.closed()).toBe(false);
		expect(mac.closed()).toBe(false);
		await expect(mac.call(CH.pairingLock, {})).rejects.toThrow("locked already");
	});

	it("revoking a device drops its live connections", async () => {
		const box = fakeEngine();
		const guard = guardIn();
		const owner = guard.store.lock("MacBook", "desktop");
		const mac = connect(box, guard);
		await mac.call(CH.systemHello, { token: owner.token });
		const { code } = (await mac.call(CH.pairingInvite)) as PairingInviteDTO;
		const phone = connect(box, guard);
		const grant = (await phone.call(CH.pairingRedeem, {
			code,
			label: "iPhone",
		})) as PairingGrantDTO;
		await mac.call(CH.pairingRevoke, { id: grant.device.id });
		await tick();
		expect(phone.closed()).toBe(true);
		expect(mac.closed()).toBe(false);
	});

	it("drops a connection after five wrong codes, and stops taking codes after many", async () => {
		const box = fakeEngine();
		const guard: PairingGuard = {
			store: new Pairings(dir()),
			live: new LiveConnections(),
			limiter: new RedeemLimiter(8),
		};
		guard.store.lock("MacBook", "desktop");
		const c = connect(box, guard);
		for (let i = 0; i < 5; i++)
			await expect(c.call(CH.pairingRedeem, { code: "AAAAAAAA" })).rejects.toThrow("isn't valid");
		expect(c.closed()).toBe(true);
		const d = connect(box, guard);
		for (let i = 0; i < 3; i++)
			await expect(d.call(CH.pairingRedeem, { code: "AAAAAAAA" })).rejects.toThrow("isn't valid");
		// Eight wrong codes across connections: even a right one waits now.
		const { code } = guard.store.invite();
		await expect(d.call(CH.pairingRedeem, { code })).rejects.toThrow("Too many wrong codes");
	});
});
