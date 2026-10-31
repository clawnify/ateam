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
import { WorktreeGuard } from "../src/worktree-guard";

// The SSH shape: readable !== writable. Two pipes cross-wire a client and server
// exactly like a child process's stdout/stdin, without spawning ssh.
function makeEngine(db: AteamDb): Engine {
	const ee = new EventEmitter();
	return {
		services: {
			db,
			pty: { has: () => false },
			mergeQueue: {},
			loopRunner: { describe: () => [] },
			pendingSeeds: new Map(),
			worktreeGuard: new WorktreeGuard(),
		},
		on: (event: string, cb: (p: unknown) => void) => {
			ee.on(event, cb);
			return () => ee.off(event, cb);
		},
		sendTaskUpdated: (id: string) => ee.emit("taskUpdated", { id }),
		sendLoopsUpdated: () => ee.emit("loopsUpdated", []),
		ptyReady: () => Promise.resolve(),
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

describe("line framing", () => {
	/** Frames the client side reads off `s2c`, fed as the given chunks. */
	function framesFrom(chunks: (Buffer | string)[]): unknown[] {
		const s2c = new PassThrough();
		const frames: unknown[] = [];
		streamClientTransport(s2c, new PassThrough()).onFrame((f) => frames.push(f));
		for (const c of chunks) s2c.write(c);
		return frames;
	}
	const flush = () => new Promise((r) => setTimeout(r, 0));

	it("joins a frame split across many chunks, and splits several in one", async () => {
		const line = `${JSON.stringify({ id: 1, result: "x".repeat(5000) })}\n`;
		const parts = line.match(/[\s\S]{1,7}/g) ?? [];
		const frames = framesFrom([
			...parts,
			`${JSON.stringify({ id: 2 })}\n\n${JSON.stringify({ id: 3 })}\n`,
		]);
		await flush();
		expect(frames).toEqual([{ id: 1, result: "x".repeat(5000) }, { id: 2 }, { id: 3 }]);
	});

	it("reads many frames however the chunks cut them", async () => {
		const sent = Array.from({ length: 50 }, (_, i) => ({ id: i, data: "y".repeat(i) }));
		const bytes = Buffer.from(sent.map((f) => `${JSON.stringify(f)}\n`).join(""));
		const chunks: Buffer[] = [];
		for (let i = 0; i < bytes.length; i += 13) chunks.push(bytes.subarray(i, i + 13));
		const frames = framesFrom(chunks);
		await flush();
		expect(frames).toEqual(sent);
	});

	it("keeps a character whose bytes arrive in two chunks", async () => {
		const bytes = Buffer.from(`${JSON.stringify({ name: "café ✓" })}\n`, "utf8");
		const cut = bytes.indexOf(0xa9); // the second byte of "é"
		const frames = framesFrom([bytes.subarray(0, cut), bytes.subarray(cut)]);
		await flush();
		expect(frames).toEqual([{ name: "café ✓" }]);
	});

	it("reads a 25 MB frame that arrives 64 KiB at a time", async () => {
		const payload = "A".repeat(25 * 1024 * 1024);
		const bytes = Buffer.from(`${JSON.stringify({ id: 9, args: [payload] })}\n`);
		const chunks: Buffer[] = [];
		for (let i = 0; i < bytes.length; i += 64 * 1024) chunks.push(bytes.subarray(i, i + 64 * 1024));
		const frames = framesFrom(chunks) as { id: number; args: string[] }[];
		await flush();
		expect(frames).toHaveLength(1);
		expect(frames[0]?.args[0]?.length).toBe(payload.length);
	});
});
