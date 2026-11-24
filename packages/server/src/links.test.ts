// Links between boxes (cross-box): a box linking to another through the real
// gate (serveRpc, with a pairing store) over an in-memory pipe.
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CH,
	type ClientFrame,
	type ClientTransport,
	createRpcClient,
	linksClient,
	type RpcClient,
	type ServerFrame,
	splitClientTransport,
	splitServerTransport,
} from "@ateam/protocol";
import type { Dispatcher } from "./dispatcher";
import type { Engine } from "./engine";
import { BoxLinks, LINKS_FILE, type LinkConnector, OFFER_AWAY, offerExtension } from "./links";
import { Pairings } from "./pairing";
import {
	BOX_REFUSED,
	LinkLimiter,
	LiveConnections,
	type PairingGuard,
	RedeemLimiter,
	type ServerTransport,
	serveRpc,
} from "./rpc";

const dir = () => mkdtempSync(join(tmpdir(), "links-"));
const tick = () => new Promise((r) => setTimeout(r, 2));

/** A box: its tasks for peers:list, and the messages peers:sendFromBox brought. */
function fakeBox(tasks: { taskId: string; name: string; branch: string }[]) {
	const listeners = new Map<string, Set<(p: unknown) => void>>();
	const engine = {
		on: (event: string, l: (p: unknown) => void) => {
			const set = listeners.get(event) ?? new Set();
			set.add(l);
			listeners.set(event, set);
			return () => set.delete(l);
		},
	} as unknown as Engine;
	const received: unknown[] = [];
	// The name each message's link goes by here, as the gate passed it on.
	const via: (string | null | undefined)[] = [];
	const dispatcher = {
		handle: async (method: string, args: unknown[], ctx?: { linkName?: string | null }) => {
			if (method === CH.systemHello) return { protocolVersion: 30, agents: [] };
			if (method === CH.peersList)
				return tasks.map((t) => ({
					...t,
					project: "Repo",
					repo: "owner/repo",
					agent: "claude",
					state: "idle",
					column: "in_progress",
					description: null,
					summary: null,
				}));
			if (method === CH.peersSendFromBox) {
				received.push(args[0]);
				via.push(ctx?.linkName);
				return { ok: true, reason: "sent." };
			}
			return `did ${method}`;
		},
		release: () => {},
	} as unknown as Dispatcher;
	const guard: PairingGuard = {
		store: new Pairings(dir()),
		live: new LiveConnections(),
		limiter: new RedeemLimiter(),
	};
	const emit = (event: string, payload: unknown) => {
		for (const l of listeners.get(event) ?? []) l(payload);
	};
	return { engine, dispatcher, guard, received, via, emit };
}

/** A client and the box's gate, joined in memory. */
function pipe(box: ReturnType<typeof fakeBox>): ReturnType<LinkConnector> {
	let toServer: ((f: ClientFrame) => void) | null = null;
	let toClient: ((f: ServerFrame) => void) | null = null;
	const onClose: (() => void)[] = [];
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		for (const h of onClose) h();
	};
	const server: ServerTransport = {
		send: (f) => {
			if (!closed) queueMicrotask(() => toClient?.(f));
		},
		onFrame: (h) => {
			toServer = h;
		},
		onClose: (h) => {
			onClose.push(h);
		},
		close,
	};
	serveRpc(box.engine, box.dispatcher, server, [], { pairing: box.guard });
	const transport: ClientTransport = {
		send: (f) => {
			if (!closed) queueMicrotask(() => toServer?.(f));
		},
		onFrame: (h) => {
			toClient = h;
		},
		onClose: (h) => {
			onClose.push(h);
		},
	};
	return { transport, close };
}

function linksTo(boxes: Record<string, ReturnType<typeof fakeBox> | "down">, d = dir()) {
	return new BoxLinks({
		dataDir: d,
		connect: (url) => {
			const box = boxes[url];
			if (!box || box === "down") throw new Error("connection refused");
			return pipe(box);
		},
		retryMs: [60_000],
		callTimeoutMs: 500,
	});
}

const BETA = "ws://100.64.0.2:8787";
const GAMMA = "ws://100.64.0.3:8787";

describe("links to other boxes", () => {
	it("link to an open box, list its tasks with their box, and deliver naming this box", async () => {
		const beta = fakeBox([{ taskId: "t-api", name: "api", branch: "feat/api" }]);
		const links = linksTo({ [BETA]: beta });
		const status = await links.set({ self: "alpha", links: [{ name: "beta", url: BETA }] });
		expect(status).toEqual([{ name: "beta", url: BETA, state: "connected", device: null }]);
		expect(links.active()).toBe(true);

		const listed = await links.list(undefined);
		expect(listed.unreachable).toEqual([]);
		expect(listed.peers).toHaveLength(1);
		expect(listed.peers[0]).toMatchObject({ taskId: "t-api", name: "api", box: "beta" });

		expect(await links.find("API")).toEqual({ box: "beta", taskId: "t-api" });
		expect(await links.find("feat/api")).toEqual({ box: "beta", taskId: "t-api" });
		expect((await links.find("nobody")).box).toBeNull();

		const sent = await links.deliver("beta", {
			to: "t-api",
			body: "please rebase",
			hop: 3,
			from: { taskId: "t-here", name: "web", agent: "Claude Code" },
		});
		expect(sent).toEqual({ ok: true, reason: "on the box beta: sent." });
		expect(beta.received).toEqual([
			{
				to: "t-api",
				body: "please rebase",
				hop: 3,
				from: { taskId: "t-here", name: "web", agent: "Claude Code", box: "alpha" },
			},
		]);
		// The Lead here: as this box's Lead, which beta weighs as a colleague.
		const [backend] = links.backends;
		expect(await links.asLead(backend as never, "t-api", "pause")).toEqual({
			ok: true,
			reason: "on the box beta: sent.",
		});
		expect(beta.received.at(-1)).toEqual({
			to: "t-api",
			body: "pause",
			hop: 1,
			from: { taskId: "lead", name: "Lead", agent: "Lead", lead: true, box: "alpha" },
		});
		links.dispose();
	});

	it("pairs with the code the Mac handed over, and keeps the token for the next start", async () => {
		const beta = fakeBox([]);
		beta.guard.store.lock("Mac", "desktop");
		const { code } = beta.guard.store.invite();
		const d = dir();
		const links = linksTo({ [BETA]: beta }, d);
		const [linked] = await links.set({ self: "alpha", links: [{ name: "beta", url: BETA, code }] });
		expect(linked?.state).toBe("connected");
		expect(linked?.device).toEqual(expect.any(String));
		const devices = beta.guard.store.status(null).devices;
		expect(devices.find((x) => x.id === linked?.device)).toMatchObject({
			label: "alpha",
			kind: "box",
		});
		const file = join(d, LINKS_FILE);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(readFileSync(file, "utf8")).toContain('"token"');
		links.dispose();

		// The box restarts: the link comes back on its token, no code needed.
		const again = linksTo({ [BETA]: beta }, d);
		again.start();
		for (let i = 0; i < 50 && again.status()[0]?.state !== "connected"; i++) await tick();
		expect(again.status()[0]).toMatchObject({ name: "beta", state: "connected" });
		again.dispose();
	});

	it("is refused by a locked box it isn't paired with, rather than read as down", async () => {
		const beta = fakeBox([]);
		beta.guard.store.lock("Mac", "desktop");
		const links = linksTo({ [BETA]: beta });
		const [link] = await links.set({ self: "alpha", links: [{ name: "beta", url: BETA }] });
		expect(link?.state).toBe("refused");
		expect(link?.reason).toContain("cross-box");
		links.dispose();
	});

	it("reports a box it can't reach, while the others still answer", async () => {
		const beta = fakeBox([{ taskId: "t-api", name: "api", branch: "feat/api" }]);
		const links = linksTo({ [BETA]: beta, [GAMMA]: "down" });
		await links.set({
			self: "alpha",
			links: [
				{ name: "beta", url: BETA },
				{ name: "gamma", url: GAMMA },
			],
		});
		const listed = await links.list(undefined);
		expect(listed.peers.map((p) => p.box)).toEqual(["beta"]);
		expect(listed.unreachable).toEqual([{ box: "gamma", reason: "connection refused" }]);
		const missing = await links.find("nobody");
		expect(missing.box === null && missing.reason).toContain("Couldn't ask: gamma");
		expect(
			await links.deliver("gamma", {
				to: "x",
				body: "hi",
				hop: 1,
				from: { taskId: "a", name: "b", agent: "c" },
			}),
		).toMatchObject({ ok: false });
		links.dispose();
	});

	it("drops a link that is no longer wanted", async () => {
		const beta = fakeBox([]);
		const links = linksTo({ [BETA]: beta });
		await links.set({ self: "alpha", links: [{ name: "beta", url: BETA }] });
		expect(await links.set({ self: "alpha", links: [] })).toEqual([]);
		expect(links.active()).toBe(false);
		expect(links.backends).toEqual([]);
		links.dispose();
	});

	it("refuses links:set input it can't use", async () => {
		const links = linksTo({});
		await expect(links.set({ links: [] })).rejects.toThrow("self");
		await expect(
			links.set({ self: "alpha", links: [{ name: "beta", url: "http://evil" }] }),
		).rejects.toThrow("ws://");
		links.dispose();
	});
});

/** A Mac holding a box over one connection, wired as the daemon and the desktop
 *  wire it: the box's gate with the offer on it (cli.ts serveClient), and on the
 *  way back the Mac's own, narrowed to a link (mac-link.ts). */
function macHolding(
	box: ReturnType<typeof fakeBox>,
	boxLinks: BoxLinks,
	mac: ReturnType<typeof fakeBox>,
	limiter?: LinkLimiter,
) {
	let toServer: ((f: ClientFrame) => void) | null = null;
	let toClient: ((f: ServerFrame) => void) | null = null;
	const onClose: (() => void)[] = [];
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		for (const h of onClose) h();
	};
	const server: ServerTransport = {
		send: (f) => {
			if (!closed) queueMicrotask(() => toClient?.(f));
		},
		onFrame: (h) => {
			toServer = h;
		},
		onClose: (h) => {
			onClose.push(h);
		},
		close,
	};
	const client: ClientTransport = {
		send: (f) => {
			if (!closed) queueMicrotask(() => toServer?.(f));
		},
		onFrame: (h) => {
			toClient = h;
		},
		onClose: (h) => {
			onClose.push(h);
		},
	};
	const boxEnd = splitServerTransport(server);
	const offer = offerExtension(boxLinks, boxEnd.back, 500);
	server.onClose?.(() => offer.close());
	serveRpc(box.engine, box.dispatcher, boxEnd.main, [offer], { pairing: box.guard });
	const macEnd = splitClientTransport(client);
	serveRpc(mac.engine, mac.dispatcher, macEnd.back, [], { link: { name: "the-box", limiter } });
	return { rpc: createRpcClient(macEnd.main), close };
}

const MAC_TASK = { taskId: "m-1", name: "design", branch: "feat/design" };
const message = (n: number) => ({
	to: "m-1",
	body: `note ${n}`,
	hop: 1,
	from: { taskId: "t-here", name: "web", agent: "Claude Code" },
});

describe("the Mac in a box's links", () => {
	it("is reached back down the connection it opened, and never stored", async () => {
		const d = dir();
		const boxLinks = linksTo({}, d);
		const mac = fakeBox([MAC_TASK]);
		const held = macHolding(fakeBox([]), boxLinks, mac);
		expect(boxLinks.active()).toBe(false);
		await linksClient(held.rpc).offer("studio-mac");

		expect(boxLinks.active()).toBe(true);
		const listed = await boxLinks.list(undefined);
		expect(listed.unreachable).toEqual([]);
		expect(listed.peers[0]).toMatchObject({ taskId: "m-1", name: "design", box: "studio-mac" });
		expect(await boxLinks.find("feat/design")).toEqual({ box: "studio-mac", taskId: "m-1" });
		expect(boxLinks.nameOf(boxLinks.backends[0])).toBe("studio-mac");

		expect(await boxLinks.deliver("studio-mac", message(1))).toEqual({
			ok: true,
			reason: "on the box studio-mac: sent.",
		});
		// Named by what the Mac calls the box, whatever the message says of itself.
		expect(mac.via).toEqual(["the-box"]);

		// Nothing to redial or to carry over a restart, and links:list is the stored links.
		expect(boxLinks.status()).toEqual([]);
		expect(existsSync(join(d, LINKS_FILE))).toBe(false);
		boxLinks.dispose();
	});

	it("gives the box a link's share and no more, though the box never said it was one", async () => {
		const boxLinks = linksTo({});
		const mac = fakeBox([MAC_TASK]);
		const held = macHolding(fakeBox([]), boxLinks, mac);
		await linksClient(held.rpc).offer("studio-mac");
		const toMac = boxLinks.backends[0];

		expect(await toMac?.handle(CH.tasksList, ["p-1"])).toBe(`did ${CH.tasksList}`);
		for (const method of [
			CH.tasksRemove,
			CH.tasksAnswerQuestion,
			CH.peersSendFromLead,
			"pty:write",
		])
			await expect(toMac?.handle(method, [{}])).rejects.toThrow(BOX_REFUSED);
		boxLinks.dispose();
	});

	it("caps what the box sends the Mac", async () => {
		const boxLinks = linksTo({});
		const mac = fakeBox([MAC_TASK]);
		const held = macHolding(fakeBox([]), boxLinks, mac, new LinkLimiter(2, 60_000));
		await linksClient(held.rpc).offer("studio-mac");

		expect((await boxLinks.deliver("studio-mac", message(1))).ok).toBe(true);
		expect((await boxLinks.deliver("studio-mac", message(2))).ok).toBe(true);
		const third = await boxLinks.deliver("studio-mac", message(3));
		expect(third.ok).toBe(false);
		expect(third.reason).toContain("rate limit");
		expect(mac.received).toHaveLength(2);
		boxLinks.dispose();
	});

	it("stays listed, out of reach, once its connection ends, and comes back on the next", async () => {
		const boxLinks = linksTo({});
		const mac = fakeBox([MAC_TASK]);
		const box = fakeBox([]);
		const first = macHolding(box, boxLinks, mac);
		await linksClient(first.rpc).offer("studio-mac");
		const [backend] = boxLinks.backends;
		first.close();

		const away = await boxLinks.list(undefined);
		expect(away.peers).toEqual([]);
		expect(away.unreachable).toEqual([{ box: "studio-mac", reason: OFFER_AWAY }]);
		const lost = await boxLinks.find("m-1");
		expect(lost.box === null && lost.reason).toContain("Couldn't ask: studio-mac");
		expect((await boxLinks.deliver("studio-mac", message(1))).ok).toBe(false);

		const second = macHolding(box, boxLinks, mac);
		await linksClient(second.rpc).offer("studio-mac");
		expect((await boxLinks.list(undefined)).peers.map((p) => p.box)).toEqual(["studio-mac"]);
		// The same backend, so a Lead's router keeps routing its tasks to it.
		expect(boxLinks.backends).toEqual([backend as never]);
		// The first connection ending late is old news.
		first.close();
		expect((await boxLinks.list(undefined)).unreachable).toEqual([]);
		boxLinks.dispose();
	});

	it("is left alone by links:set, and goes when it withdraws", async () => {
		const beta = fakeBox([{ taskId: "t-api", name: "api", branch: "feat/api" }]);
		const boxLinks = linksTo({ [BETA]: beta });
		const held = macHolding(fakeBox([]), boxLinks, fakeBox([MAC_TASK]));
		await linksClient(held.rpc).offer("studio-mac");

		await boxLinks.set({ self: "alpha", links: [{ name: "beta", url: BETA }] });
		await boxLinks.set({ self: "alpha", links: [] });
		expect((await boxLinks.list(undefined)).peers.map((p) => p.box)).toEqual(["studio-mac"]);

		await linksClient(held.rpc).withdraw();
		expect(boxLinks.active()).toBe(false);
		expect(boxLinks.backends).toEqual([]);
		boxLinks.dispose();
	});

	it("refuses an offer under a linked box's name, or under none", async () => {
		const boxLinks = linksTo({ [BETA]: fakeBox([]) });
		await boxLinks.set({ self: "alpha", links: [{ name: "beta", url: BETA }] });
		const held = macHolding(fakeBox([]), boxLinks, fakeBox([]));
		await expect(linksClient(held.rpc).offer("beta")).rejects.toThrow("already");
		await expect(linksClient(held.rpc).offer("  ")).rejects.toThrow("name");
		boxLinks.dispose();
	});

	it("is not taken from a computer that doesn't answer on the way back", async () => {
		const boxLinks = linksTo({});
		// An end that calls links:offer and serves nothing back.
		const pair = pipeWith(fakeBox([]), boxLinks);
		await expect(linksClient(createRpcClient(pair.transport)).offer("ghost")).rejects.toThrow(
			"timed out",
		);
		expect(boxLinks.active()).toBe(false);
		boxLinks.dispose();
	});
});

/** A client on a box's gate with the offer on it, serving nothing back. */
function pipeWith(box: ReturnType<typeof fakeBox>, boxLinks: BoxLinks): ReturnType<LinkConnector> {
	let toServer: ((f: ClientFrame) => void) | null = null;
	let toClient: ((f: ServerFrame) => void) | null = null;
	const server: ServerTransport = {
		send: (f) => queueMicrotask(() => toClient?.(f)),
		onFrame: (h) => {
			toServer = h;
		},
	};
	const boxEnd = splitServerTransport(server);
	serveRpc(box.engine, box.dispatcher, boxEnd.main, [offerExtension(boxLinks, boxEnd.back, 50)], {
		pairing: box.guard,
	});
	return {
		transport: {
			send: (f) => queueMicrotask(() => toServer?.(f)),
			onFrame: (h) => {
				toClient = h;
			},
		},
		close: () => {},
	};
}

describe("the boxes a Mac holds, as its own engine's links", () => {
	it("lists and messages a held box's tasks over the Mac's own connection, which stays whole", async () => {
		const box = fakeBox([{ taskId: "t-api", name: "api", branch: "feat/api" }]);
		const rpc = createRpcClient(pipe(box).transport);
		const macLinks = new BoxLinks({ dataDir: dir(), self: "studio-mac", callTimeoutMs: 500 });
		expect(macLinks.active()).toBe(false);
		const detach = macLinks.attach("box-a", rpc, "this Mac isn't connected to it right now");

		expect((await macLinks.list(undefined)).peers[0]).toMatchObject({
			taskId: "t-api",
			box: "box-a",
		});
		expect(await macLinks.deliver("box-a", { ...message(1), to: "t-api" })).toMatchObject({
			ok: true,
		});
		expect(box.received.at(-1)).toMatchObject({ from: { box: "studio-mac", name: "web" } });
		// Attaching never narrows the connection the desktop drives the box with.
		expect(await rpc.call(CH.tasksRemove, [{}])).toBe(`did ${CH.tasksRemove}`);

		detach();
		expect((await macLinks.list(undefined)).unreachable).toEqual([
			{ box: "box-a", reason: "this Mac isn't connected to it right now" },
		]);
		macLinks.drop("box-a");
		expect(macLinks.active()).toBe(false);
		macLinks.dispose();
	});
});

describe("a link whose machine went quiet without closing", () => {
	// A laptop with its lid shut, or a box put to sleep: the connection stays
	// open and nothing on it answers.
	const never = new Promise<never>(() => {});

	it("takes an attached one as out of reach after one wait, and back when it answers", async () => {
		let asleep = false;
		const rpc = {
			call: (method: string) =>
				asleep
					? never
					: Promise.resolve(method === CH.peersList ? [{ ...MAC_TASK, project: "Repo" }] : {}),
			on: () => () => {},
		} as unknown as RpcClient;
		const links = new BoxLinks({ dataDir: dir(), callTimeoutMs: 200, probeMs: 20 });
		links.attach("studio-mac", rpc, OFFER_AWAY);
		expect((await links.list(undefined)).peers).toHaveLength(1);

		asleep = true;
		// The first to ask waits for it, once.
		expect((await links.list(undefined)).unreachable).toHaveLength(1);
		// Nobody after that does, and they are told why.
		const started = Date.now();
		expect(await links.list(undefined)).toEqual({
			peers: [],
			more: false,
			unreachable: [{ box: "studio-mac", reason: OFFER_AWAY }],
		});
		expect((await links.deliver("studio-mac", message(1))).ok).toBe(false);
		expect(() => links.backends[0]?.handle(CH.tasksList, ["p"])).toThrow("can't be reached");
		expect(Date.now() - started).toBeLessThan(100);

		// It wakes on the same connection: the check takes it back by itself.
		asleep = false;
		for (let i = 0; i < 200 && (await links.list(undefined)).peers.length === 0; i++) await tick();
		expect((await links.list(undefined)).unreachable).toEqual([]);
		links.dispose();
	});

	it("notices an attached one by its check, before anyone has to wait for it", async () => {
		let asleep = false;
		const rpc = {
			call: () => (asleep ? never : Promise.resolve([])),
			on: () => () => {},
		} as unknown as RpcClient;
		const links = new BoxLinks({ dataDir: dir(), callTimeoutMs: 40, probeMs: 10 });
		links.attach("studio-mac", rpc, OFFER_AWAY);
		asleep = true;
		// Nobody calls: the check alone finds it silent.
		await new Promise((r) => setTimeout(r, 150));
		const started = Date.now();
		expect((await links.list(undefined)).unreachable).toEqual([
			{ box: "studio-mac", reason: OFFER_AWAY },
		]);
		expect(Date.now() - started).toBeLessThan(30);
		links.dispose();
	});

	it("drops a stored one and dials it again, so a sleeping box is waited for once", async () => {
		const beta = fakeBox([{ taskId: "t-api", name: "api", branch: "feat/api" }]);
		const answer = beta.dispatcher.handle.bind(beta.dispatcher);
		let asleep = false;
		beta.dispatcher.handle = ((method: string, args: unknown[]) =>
			asleep ? never : answer(method, args)) as never;
		const links = linksTo({ [BETA]: beta });
		await links.set({ self: "alpha", links: [{ name: "beta", url: BETA }] });
		expect((await links.list(undefined)).peers).toHaveLength(1);

		asleep = true;
		expect((await links.list(undefined)).unreachable).toHaveLength(1);
		expect(links.status()[0]).toMatchObject({
			state: "unreachable",
			reason: "it stopped answering",
		});
		const started = Date.now();
		expect((await links.list(undefined)).unreachable).toEqual([
			{ box: "beta", reason: "it stopped answering" },
		]);
		expect(Date.now() - started).toBeLessThan(100);
		links.dispose();
	});
});
