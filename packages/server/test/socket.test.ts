import { EventEmitter } from "node:events";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { type AteamDb, repo } from "@ateam/db";
import { CH, createRpcClient } from "@ateam/protocol";
import { createTestDb } from "../../db/test/helpers/test-db";
import { createDispatcher } from "../src/dispatcher";
import type { Engine } from "../src/engine";
import { serveRpc } from "../src/rpc";
import { socketClientTransport, socketServerTransport } from "../src/transport/socket";

let counter = 0;
const servers: Server[] = [];

afterEach(() => {
	for (const s of servers.splice(0)) s.close();
});

function makeEngine(db: AteamDb): Engine {
	const ee = new EventEmitter();
	return {
		services: { db, pty: { has: () => false }, mergeQueue: {}, loopRunner: { describe: () => [] } },
		on: (event: string, cb: (p: unknown) => void) => {
			ee.on(event, cb);
			return () => ee.off(event, cb);
		},
		sendTaskUpdated: (id: string) => ee.emit("taskUpdated", { id }),
		sendLoopsUpdated: () => ee.emit("loopsUpdated", []),
	} as unknown as Engine;
}

// Stand up a daemon-like RPC server on a temp unix socket, then a connected
// RpcClient — the same socketServer/Client transports the `ateam` daemon uses.
async function connectPair(db: AteamDb) {
	const engine = makeEngine(db);
	const dispatcher = createDispatcher(engine);
	const sockPath = join(tmpdir(), `ateam-t${process.pid}-${counter++}.sock`);
	const server = createServer((sock) => serveRpc(engine, dispatcher, socketServerTransport(sock)));
	servers.push(server);
	await new Promise<void>((res) => server.listen(sockPath, res));
	const sock = connect(sockPath);
	await new Promise<void>((res) => sock.once("connect", () => res()));
	const rpc = createRpcClient(socketClientTransport(sock));
	return { rpc, sock };
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

describe("RPC over a real unix socket", () => {
	it("round-trips a request through the dispatcher", async () => {
		const db = createTestDb();
		const { rpc, sock } = await connectPair(db);
		const { projectId, task } = seedTask(db);

		const listed = (await rpc.call(CH.tasksList, [projectId])) as Array<{ id: string }>;
		expect(listed.map((t) => t.id)).toEqual([task.id]);
		sock.end();
	});

	it("streams an engine event over the socket, then a response", async () => {
		const db = createTestDb();
		const { rpc, sock } = await connectPair(db);
		const { task } = seedTask(db);

		const events: string[] = [];
		rpc.on("taskUpdated", (p) => events.push((p as { id: string }).id));

		const moved = (await rpc.call(CH.tasksSetColumn, [task.id, "review"])) as { column: string };
		expect(moved.column).toBe("review");
		expect(events).toContain(task.id);
		sock.end();
	});

	it("surfaces the server error for an unknown method", async () => {
		const { rpc, sock } = await connectPair(createTestDb());
		expect(rpc.call("nope:nope", [])).rejects.toThrow(/Unknown method/);
		sock.end();
	});
});
