// Links between boxes (cross-box): a box linking to another through the real
// gate (serveRpc, with a pairing store) over an in-memory pipe.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CH, type ClientFrame, type ClientTransport, type ServerFrame } from "@ateam/protocol";
import type { Dispatcher } from "./dispatcher";
import type { Engine } from "./engine";
import { BoxLinks, LINKS_FILE, type LinkConnector } from "./links";
import { Pairings } from "./pairing";
import {
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
	const dispatcher = {
		handle: async (method: string, args: unknown[]) => {
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
	return { engine, dispatcher, guard, received, emit };
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
