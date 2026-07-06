import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "bun:test";
import { type AteamDb, repo } from "@ateam/db";
import { CH, createRpcClient } from "@ateam/protocol";
import { createTestDb } from "../../db/test/helpers/test-db";
import { createDispatcher } from "../src/dispatcher";
import type { Engine } from "../src/engine";
import { serveRpc } from "../src/rpc";
import { streamClientTransport, streamServerTransport } from "../src/transport/stream";

// The SSH shape: readable !== writable. Two pipes cross-wire a client and server
// exactly like a child process's stdout/stdin, without spawning ssh.
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

describe("RPC over a separate read/write stream pair (the SSH shape)", () => {
	it("round-trips a request and streams an event", async () => {
		const db = createTestDb();
		const engine = makeEngine(db);
		const c2s = new PassThrough(); // client → server
		const s2c = new PassThrough(); // server → client
		serveRpc(engine, createDispatcher(engine), streamServerTransport(c2s, s2c));
		const rpc = createRpcClient(streamClientTransport(s2c, c2s));

		const project = repo.upsertProject(db, { repoPath: "/r/a", name: "A" });
		const task = repo.createTask(db, {
			projectId: project!.id,
			name: "t",
			slug: "t",
			branch: "t",
			baseBranch: "main",
			worktreePath: "/r/a/w/t",
		});

		const events: string[] = [];
		rpc.on("taskUpdated", (p) => events.push((p as { id: string }).id));

		const listed = (await rpc.call(CH.tasksList, [project!.id])) as Array<{ id: string }>;
		expect(listed.map((t) => t.id)).toEqual([task.id]);

		const moved = (await rpc.call(CH.tasksSetColumn, [task.id, "review"])) as { column: string };
		expect(moved.column).toBe("review");
		expect(events).toContain(task.id);
	});
});
