import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { type AteamDb, repo } from "@ateam/db";
import {
	buildAteamApi,
	createRpcClient,
	type NativeClientApi,
	wsClientTransport,
} from "@ateam/protocol";
import { WebSocketServer } from "ws";
import { createTestDb } from "../../db/test/helpers/test-db";
import { createDispatcher } from "../src/dispatcher";
import type { Engine } from "../src/engine";
import { serveRpc } from "../src/rpc";
import { wsServerTransport } from "../src/transport/ws";

// The mobile shape: the phone speaks the platform-global WebSocket to the box's
// opt-in WS listener. This exercises the WHOLE path — wsServerTransport ↔ real ws
// server ↔ Bun's global WebSocket client ↔ wsClientTransport ↔ buildAteamApi — so
// it proves the transport the phone actually uses, not a stand-in.
function makeEngine(db: AteamDb): Engine {
	const ee = new EventEmitter();
	return {
		services: {
			db,
			pty: { has: () => false },
			mergeQueue: {},
			loopRunner: { describe: () => [] },
			pendingSeeds: new Map(),
		},
		on: (event: string, cb: (p: unknown) => void) => {
			ee.on(event, cb);
			return () => ee.off(event, cb);
		},
		sendTaskUpdated: (id: string) => {
			const task = repo.getTask(db, id);
			if (task) ee.emit("taskUpdated", { id: task.id, column: task.column });
		},
		sendLoopsUpdated: () => ee.emit("loopsUpdated", []),
	} as unknown as Engine;
}

const native: NativeClientApi = {
	pathForFile: () => "",
	pick: async () => null,
	pickFiles: async () => [],
	attachImages: async () => ({ mode: "none" as const }),
	attachClipboardImage: async () => ({ mode: "none" as const }),
};

describe("buildAteamApi over a real WebSocket (the phone's transport)", () => {
	it("round-trips typed calls and streams a task event over ws", async () => {
		const db = createTestDb();
		const engine = makeEngine(db);
		const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		wss.on("connection", (sock) =>
			serveRpc(engine, createDispatcher(engine), wsServerTransport(sock)),
		);
		await new Promise<void>((resolve) => wss.once("listening", resolve));
		const { port } = wss.address() as AddressInfo;

		const client = wsClientTransport(`ws://127.0.0.1:${port}`);
		const api = buildAteamApi(createRpcClient(client.transport), native);

		const project = repo.upsertProject(db, { repoPath: "/r/a", name: "A" });
		const task = repo.createTask(db, {
			projectId: project!.id,
			name: "t",
			slug: "t",
			branch: "t",
			baseBranch: "main",
			worktreePath: "/r/a/w/t",
		});

		const updated: string[] = [];
		api.events.onTaskUpdated((t) => updated.push(t.id));

		// A call issued before the socket is OPEN must still land (frames queue and
		// flush on open) — this is the connect-time handshake behavior.
		const listed = await api.tasks.list(project!.id);
		expect(listed.map((t) => t.id)).toEqual([task.id]);

		const moved = await api.tasks.setColumn(task.id, "review");
		expect(moved.column).toBe("review");
		// Give the event a tick to cross the socket back.
		await new Promise((r) => setTimeout(r, 20));
		expect(updated).toContain(task.id);

		client.close();
		wss.close();
	});
});

// The failure the desktop's health probe exists for. A WebSocket over Tailscale
// goes HALF-OPEN on NAT/WireGuard idle timeout (or a laptop sleeping): the socket
// stays "open", nothing is delivered, and no close event ever fires. Since
// createRpcClient has no per-call timeout and relies on onClose to reject, an
// unprobed client waits forever — the board silently stops responding.
describe("a half-open WebSocket", () => {
	it("never rejects on its own, so a timed probe is what detects it", async () => {
		// A server that accepts the connection and then answers nothing, without
		// ever closing — exactly what a dead NAT mapping looks like from the client.
		const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		wss.on("connection", () => {
			/* deliberately silent: no reply, no close */
		});
		const { port } = wss.address() as AddressInfo;
		const client = wsClientTransport(`ws://127.0.0.1:${port}`);
		const rpc = createRpcClient(client.transport);

		// Unprobed: still pending well after any real reply would have arrived.
		let settled = false;
		void rpc.call("system:hello").then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await new Promise((r) => setTimeout(r, 300));
		expect(settled).toBe(false);

		// Probed: the timeout is what turns silence into a failure we can act on.
		const probe = new Promise((_res, rej) => setTimeout(() => rej(new Error("ping timeout")), 100));
		await expect(Promise.race([rpc.call("system:hello"), probe])).rejects.toThrow("ping timeout");

		client.close();
		wss.close();
	});
});

// The user's setup: one task open on the desktop AND on the phone, each its own
// WebSocket to the box. The PTY has one size; it must follow the viewer in use,
// not whichever xterm fitted itself last (which left the desktop rendered at
// phone dimensions). serveRpc names each connection, so the dispatcher can tell
// them apart — and releases the name when the connection closes.
describe("two viewers of one terminal over ws", () => {
	it("holds a second viewer's size back until it types, and releases on close", async () => {
		const db = createTestDb();
		const engine = makeEngine(db);
		const calls: string[] = [];
		(engine.services as unknown as { pty: unknown }).pty = {
			has: () => true,
			write: (id: string, data: string) => calls.push(`write ${id} ${data}`),
			resize: (id: string, c: number, r: number) => calls.push(`resize ${id} ${c}x${r}`),
		};
		const dispatcher = createDispatcher(engine);
		const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		wss.on("connection", (sock) => serveRpc(engine, dispatcher, wsServerTransport(sock)));
		await new Promise<void>((resolve) => wss.once("listening", resolve));
		const { port } = wss.address() as AddressInfo;
		const desk = wsClientTransport(`ws://127.0.0.1:${port}`);
		const phone = wsClientTransport(`ws://127.0.0.1:${port}`);
		const deskApi = buildAteamApi(createRpcClient(desk.transport), native);
		const phoneApi = buildAteamApi(createRpcClient(phone.transport), native);
		// pty.write/resize are fire-and-forget; a round-trip call fences them.
		const settle = async () => {
			await deskApi.tasks.list("none");
			await phoneApi.tasks.list("none");
		};

		deskApi.pty.resize("t", 200, 50);
		await settle();
		phoneApi.pty.resize("t", 40, 20);
		await settle();
		expect(calls).toEqual(["resize t 200x50"]);

		phoneApi.pty.write("t", "y");
		await settle();
		expect(calls.slice(1)).toEqual(["resize t 40x20", "write t y"]);

		// The phone (now the owner) goes away: its hold is released, so the
		// desktop's next report applies without it having to type first.
		phone.close();
		await new Promise((r) => setTimeout(r, 50));
		deskApi.pty.resize("t", 201, 50);
		await deskApi.tasks.list("none");
		expect(calls.slice(3)).toEqual(["resize t 201x50"]);

		desk.close();
		wss.close();
	});
});
