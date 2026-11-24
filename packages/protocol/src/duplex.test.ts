// A second session the other way over one connection (duplex.ts): the frames of
// each reach their own session, and an end that predates them ignores them.
import { describe, expect, it } from "bun:test";
import { type ServerEndTransport, splitClientTransport, splitServerTransport } from "./duplex";
import { type ClientTransport, createRpcClient } from "./rpc";

/** Two ends joined in memory, each seeing what the other sends, whatever it is. */
function wire(): { client: ClientTransport; server: ServerEndTransport; sent: unknown[] } {
	let toServer: ((f: unknown) => void) | null = null;
	let toClient: ((f: unknown) => void) | null = null;
	const sent: unknown[] = [];
	return {
		sent,
		client: {
			send: (f) => {
				sent.push(f);
				queueMicrotask(() => toServer?.(f));
			},
			onFrame: (h) => {
				toClient = h as (f: unknown) => void;
			},
		},
		server: {
			send: (f) => {
				sent.push(f);
				queueMicrotask(() => toClient?.(f));
			},
			onFrame: (h) => {
				toServer = h as (f: unknown) => void;
			},
		},
	};
}

/** Answer every request on `end` with what `reply` makes of it. */
function serve(end: ServerEndTransport, reply: (method: string) => unknown): void {
	end.onFrame((f) => {
		if (f.t === "req") end.send({ t: "res", id: f.id, ok: true, result: reply(f.method) });
	});
}

describe("a session each way over one connection", () => {
	it("keeps each session's frames to itself, with the same ids in use on both", async () => {
		const w = wire();
		const mac = splitClientTransport(w.client);
		const box = splitServerTransport(w.server);
		serve(box.main, (m) => `box did ${m}`);
		serve(mac.back, (m) => `mac did ${m}`);
		const toBox = createRpcClient(mac.main);
		const toMac = createRpcClient(box.back);

		// Both start at id 1: an answer on one must never settle the other's call.
		const [a, b] = await Promise.all([toBox.call("tasks:list"), toMac.call("peers:list")]);
		expect(a).toBe("box did tasks:list");
		expect(b).toBe("mac did peers:list");
		expect(w.sent).toContainEqual({
			t: "back",
			frame: { t: "req", id: 1, method: "peers:list", args: [] },
		});
	});

	it("carries events back too, and only to the session they are for", async () => {
		const w = wire();
		const mac = splitClientTransport(w.client);
		const box = splitServerTransport(w.server);
		const seenByBox: unknown[] = [];
		const seenByMac: unknown[] = [];
		createRpcClient(box.back).on("taskUpdated", (p) => seenByBox.push(p));
		createRpcClient(mac.main).on("taskUpdated", (p) => seenByMac.push(p));

		mac.back.send({ t: "evt", event: "taskUpdated", payload: "a Mac task" });
		box.main.send({ t: "evt", event: "taskUpdated", payload: "a box task" });
		await new Promise((r) => setTimeout(r, 2));
		expect(seenByBox).toEqual(["a Mac task"]);
		expect(seenByMac).toEqual(["a box task"]);
	});

	it("is dropped unread by a client that predates it", async () => {
		const w = wire();
		const box = splitServerTransport(w.server);
		serve(box.main, () => "fine");
		// An older desktop: one session, no split.
		const old = createRpcClient(w.client);
		const events: unknown[] = [];
		old.on("taskUpdated", (p) => events.push(p));

		box.back.send({ t: "req", id: 1, method: "peers:list", args: [] });
		expect(await old.call("system:hello")).toBe("fine");
		expect(events).toEqual([]);
	});

	it("drops a wrapped frame that carries nothing", async () => {
		const w = wire();
		const mac = splitClientTransport(w.client);
		const got: unknown[] = [];
		mac.back.onFrame((f) => got.push(f));
		w.server.send({ t: "back" } as never);
		w.server.send({ t: "back", frame: null } as never);
		await new Promise((r) => setTimeout(r, 2));
		expect(got).toEqual([]);
	});
});
