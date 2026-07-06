import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { type AteamDb, repo } from "@ateam/db";
import { buildAteamApi, createRpcClient, type NativeClientApi } from "@ateam/protocol";
import { createTestDb } from "../../db/test/helpers/test-db";
import { createDispatcher } from "../src/dispatcher";
import type { Engine } from "../src/engine";
import { serveRpc } from "../src/rpc";
import { streamClientTransport, streamServerTransport } from "../src/transport/stream";

// Same fake engine as stream.test.ts: enough services for the dispatcher's
// read/update paths, with sendTaskUpdated wired to actually emit the event.
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

// The native slice is unreachable over RPC; assert buildAteamApi delegates to it
// verbatim rather than inventing a value.
const native: NativeClientApi = {
	pathForFile: () => "/native/path",
	pick: async () => "/native/pick",
	pickFiles: async () => ["/native/a"],
	stageClipboardImage: async () => true,
	stageImagePath: async () => false,
};

describe("buildAteamApi over a live serveRpc/dispatcher (the client's view)", () => {
	it("round-trips typed calls and streams task/loop events", async () => {
		const db = createTestDb();
		const engine = makeEngine(db);
		const c2s = new PassThrough();
		const s2c = new PassThrough();
		serveRpc(engine, createDispatcher(engine), streamServerTransport(c2s, s2c));
		const api = buildAteamApi(createRpcClient(streamClientTransport(s2c, c2s)), native);

		const project = repo.upsertProject(db, { repoPath: "/r/a", name: "A" });
		const task = repo.createTask(db, {
			projectId: project!.id,
			name: "t",
			slug: "t",
			branch: "t",
			baseBranch: "main",
			worktreePath: "/r/a/w/t",
		});

		// Push event → client subscription.
		const updated: string[] = [];
		api.events.onTaskUpdated((t) => updated.push(t.id));

		// A typed request returns the DTO shape, not `unknown`.
		const listed = await api.tasks.list(project!.id);
		expect(listed.map((t) => t.id)).toEqual([task.id]);

		const moved = await api.tasks.setColumn(task.id, "review");
		expect(moved.column).toBe("review");
		expect(updated).toContain(task.id);

		// Loops path resolves (empty from the fake runner) and doesn't hang.
		expect(await api.loops.list()).toEqual([]);
	});

	it("delegates client-native methods to the native adapter, not RPC", async () => {
		const db = createTestDb();
		const engine = makeEngine(db);
		const c2s = new PassThrough();
		const s2c = new PassThrough();
		serveRpc(engine, createDispatcher(engine), streamServerTransport(c2s, s2c));
		const api = buildAteamApi(createRpcClient(streamClientTransport(s2c, c2s)), native);

		expect(api.utils.pathForFile(new File([], "x"))).toBe("/native/path");
		expect(await api.projects.pick()).toBe("/native/pick");
		expect(await api.utils.pickFiles()).toEqual(["/native/a"]);
		expect(await api.utils.stageClipboardImage()).toBe(true);
		expect(await api.utils.stageImagePath("/x")).toBe(false);
	});
});
