// The phone's connect(), against a fake box.
//
// apps/mobile is deliberately outside the workspaces ("!apps/mobile"), so it is
// outside `typecheck` and nothing here is covered by CI the way the rest is. This
// file is the part that can be: connection.ts imports @ateam/protocol and nothing
// from React Native or Expo, so it runs under plain bun.
//
// What it pins is the behaviour that changed, and that used to be a throw: a box
// on another protocol is CONNECTED, flagged, and updatable. Getting that wrong is
// invisible from the desktop, because the phone is the client with no SSH to fall
// back on.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "@ateam/protocol";
import { boxHost, connect } from "./connection";

/** A box that answers the handshake with whatever version the test asks for. */
function fakeBox(protocolVersion: number) {
	return Bun.serve({
		port: 0,
		fetch: (req, server) => (server.upgrade(req) ? undefined : new Response("no")),
		websocket: {
			message(ws, raw) {
				const frame = JSON.parse(String(raw));
				if (frame.t !== "req") return;
				const result =
					frame.method === "system:hello"
						? { protocolVersion, agents: ["claude"] }
						: frame.method === "system:update"
							? { started: true, logPath: "/home/ateam/.ateam/update.log" }
							: frame.method === "browser:view"
								? { port: 6080, password: "pw123456" }
								: null;
				ws.send(JSON.stringify({ t: "res", id: frame.id, ok: true, result }));
			},
		},
	});
}

let older: ReturnType<typeof fakeBox>;
let level: ReturnType<typeof fakeBox>;
beforeAll(() => {
	older = fakeBox(PROTOCOL_VERSION - 2);
	level = fakeBox(PROTOCOL_VERSION);
});
afterAll(() => {
	older.stop(true);
	level.stop(true);
});

describe("connect", () => {
	test("holds a box on an older protocol instead of refusing it", async () => {
		const c = await connect(`ws://127.0.0.1:${older.port}`);
		try {
			expect(c.skewed).toBe(true);
			expect(c.info.protocolVersion).toBe(PROTOCOL_VERSION - 2);
			// The point of holding it: the board surface is live, not a rejected promise.
			expect(typeof c.api.tasks.list).toBe("function");
		} finally {
			c.close(); // also clears the keepalive, which would hold the test process open
		}
	});

	test("a box on this protocol is not flagged", async () => {
		const c = await connect(`ws://127.0.0.1:${level.port}`);
		try {
			expect(c.skewed).toBe(false);
		} finally {
			c.close();
		}
	});

	test("update() reaches the box's self-update", async () => {
		const c = await connect(`ws://127.0.0.1:${older.port}`);
		try {
			expect(await c.update()).toEqual({
				started: true,
				logPath: "/home/ateam/.ateam/update.log",
			});
		} finally {
			c.close();
		}
	});
});

describe("browser view", () => {
	test("resolves against the host this socket dialed, with the engine's port", async () => {
		const c = await connect(`ws://127.0.0.1:${level.port}`);
		try {
			const { url } = await c.api.browser.view("task-1");
			expect(url.startsWith("http://127.0.0.1:6080/vnc.html#")).toBe(true);
			expect(url).toContain("password=pw123456");
		} finally {
			c.close();
		}
	});

	test("boxHost reads IPv4, names and bracketed IPv6", () => {
		expect(boxHost("ws://100.94.46.10:8787")).toBe("100.94.46.10");
		expect(boxHost("ws://box.tail.ts.net:8787/x")).toBe("box.tail.ts.net");
		expect(boxHost("ws://[fd7a::1]:8787")).toBe("[fd7a::1]");
	});
});

// A socket whose far end stops answering, and whose close never completes: what a
// phone holds after its tunnel drops. Nothing here ever fires `onclose`.
describe("a half-open socket", () => {
	let muted = false;
	let slowMs = 0;
	class HalfOpen {
		onopen: (() => void) | null = null;
		onmessage: ((e: { data: string }) => void) | null = null;
		onclose: (() => void) | null = null;
		onerror: (() => void) | null = null;
		constructor() {
			setTimeout(() => this.onopen?.(), 0);
		}
		send(raw: string) {
			if (muted) return;
			const frame = JSON.parse(raw);
			const result =
				frame.method === "system:hello" ? { protocolVersion: PROTOCOL_VERSION, agents: [] } : null;
			setTimeout(
				() =>
					this.onmessage?.({ data: JSON.stringify({ t: "res", id: frame.id, ok: true, result }) }),
				frame.method === "system:hello" ? 0 : slowMs,
			);
		}
		close() {}
	}
	const real = globalThis.WebSocket;
	const dial = (onClose: () => void) => {
		muted = false;
		slowMs = 0;
		globalThis.WebSocket = HalfOpen as never;
		return connect("ws://box:8787", { onClose, timing: { stallProbeMs: 20, pingTimeoutMs: 20 } });
	};
	afterAll(() => {
		globalThis.WebSocket = real;
	});

	test("a call that goes unanswered has the socket probed, then rejects and reports the drop", async () => {
		let drops = 0;
		const c = await dial(() => drops++);
		expect(await c.rpc.call("tasks:list")).toBeNull();
		muted = true;
		const started = Date.now();
		await expect(c.rpc.call("tasks:list")).rejects.toThrow("RPC connection closed");
		expect(drops).toBe(1);
		expect(Date.now() - started).toBeLessThan(1_000);
		// Gone for good: a later call rejects rather than waiting on a reply.
		await expect(c.rpc.call("tasks:list")).rejects.toThrow("RPC connection closed");
		expect(await c.ping()).toBe(false);
		c.close();
		expect(drops).toBe(1);
	});

	test("a slow call on a socket that still answers carries on", async () => {
		let drops = 0;
		const c = await dial(() => drops++);
		// Slower than the stall wait, so the probe runs; its hello is answered.
		slowMs = 100;
		expect(await c.rpc.call("tasks:list")).toBeNull();
		expect(drops).toBe(0);
		c.close();
	});

	test("closing it is not a drop, and rejects what was in flight", async () => {
		let drops = 0;
		const c = await dial(() => drops++);
		muted = true;
		const pending = c.rpc.call("tasks:list");
		c.close();
		await expect(pending).rejects.toThrow("RPC connection closed");
		expect(drops).toBe(0);
	});
});
