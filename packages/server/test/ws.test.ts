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
		services: { db, pty: { has: () => false }, mergeQueue: {}, loopRunner: { describe: () => [] } },
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
	stageClipboardImage: async () => false,
	stageImagePath: async () => false,
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
