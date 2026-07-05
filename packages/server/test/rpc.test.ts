import { EventEmitter } from "node:events";
import { describe, expect, it } from "bun:test";
import { type AteamDb, repo } from "@ateam/db";
import { CH, type ClientFrame, createRpcClient, type ServerFrame } from "@ateam/protocol";
import { createTestDb } from "../../db/test/helpers/test-db";
import { createDispatcher } from "../src/dispatcher";
import type { Engine } from "../src/engine";
import { serveRpc } from "../src/rpc";

// In-memory transport pair: whatever one side sends, the other receives — the
// stand-in for Electron IPC / SSH stdio, proving the layer is transport-neutral.
function makePair() {
	let toClient: ((f: ServerFrame) => void) | null = null;
	let toServer: ((f: ClientFrame) => void) | null = null;
	const server = {
		send: (f: ServerFrame) => toClient?.(f),
		onFrame: (cb: (f: ClientFrame) => void) => {
			toServer = cb;
		},
		onClose: () => {},
	};
	const client = {
		send: (f: ClientFrame) => toServer?.(f),
		onFrame: (cb: (f: ServerFrame) => void) => {
			toClient = cb;
		},
	};
	return { server, client };
}

// A fake engine with a real emitter: the dispatcher's DB-backed handlers run for
// real, and sendTaskUpdated emits so we can assert events reach the client.
function makeEngine(db: AteamDb): Engine {
	const ee = new EventEmitter();
	return {
		services: {
			db,
			pty: { has: () => false },
			mergeQueue: {},
			loopRunner: { describe: () => [] },
		},
		on: (event: string, cb: (p: unknown) => void) => {
			ee.on(event, cb);
			return () => ee.off(event, cb);
		},
		sendTaskUpdated: (id: string) => ee.emit("taskUpdated", { id }),
		sendLoopsUpdated: () => ee.emit("loopsUpdated", []),
	} as unknown as Engine;
}

function seedTask(db: AteamDb) {
	const project = repo.upsertProject(db, { repoPath: "/r/a", name: "A" });
	const task = repo.createTask(db, {
		projectId: project!.id,
		name: "t",
		slug: "t",
		branch: "t",
		baseBranch: "main",
		worktreePath: "/r/a/w/t",
	});
	return { projectId: project!.id, task };
}

describe("serveRpc + createRpcClient over an in-memory transport", () => {
	it("round-trips a request through the real dispatcher", async () => {
		const db = createTestDb();
		const engine = makeEngine(db);
		const { server, client } = makePair();
		serveRpc(engine, createDispatcher(engine), server);
		const rpc = createRpcClient(client);

		const { projectId, task } = seedTask(db);
		const listed = (await rpc.call(CH.tasksList, [projectId])) as Array<{ id: string }>;
		expect(listed.map((t) => t.id)).toEqual([task.id]);
	});

	it("rejects an unknown method with the server's error", async () => {
		const engine = makeEngine(createTestDb());
		const { server, client } = makePair();
		serveRpc(engine, createDispatcher(engine), server);
		const rpc = createRpcClient(client);
		expect(rpc.call("nope:nope", [])).rejects.toThrow(/Unknown method/);
	});

	it("delivers engine events triggered by a call as notifications", async () => {
		const db = createTestDb();
		const engine = makeEngine(db);
		const { server, client } = makePair();
		serveRpc(engine, createDispatcher(engine), server);
		const rpc = createRpcClient(client);

		const { task } = seedTask(db);
		const events: Array<{ id: string }> = [];
		rpc.on("taskUpdated", (p) => events.push(p as { id: string }));

		const moved = (await rpc.call(CH.tasksSetColumn, [task.id, "review"])) as { column: string };
		expect(moved.column).toBe("review");
		// The setColumn handler's sendTaskUpdated must reach the client as an event.
		expect(events.map((e) => e.id)).toContain(task.id);
	});

	it("stops delivering events after dispose", async () => {
		const db = createTestDb();
		const engine = makeEngine(db);
		const { server, client } = makePair();
		const dispose = serveRpc(engine, createDispatcher(engine), server);
		const rpc = createRpcClient(client);

		const { task } = seedTask(db);
		const events: string[] = [];
		rpc.on("taskUpdated", () => events.push("hit"));

		dispose(); // client disconnected — subscriptions freed
		engine.sendTaskUpdated(task.id);
		expect(events).toEqual([]);
	});
});
