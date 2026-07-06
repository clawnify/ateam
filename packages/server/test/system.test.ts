import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { AteamDb } from "@ateam/db";
import { createRpcClient, PROTOCOL_VERSION, serverHandshake } from "@ateam/protocol";
import { createTestDb } from "../../db/test/helpers/test-db";
import { createDispatcher } from "../src/dispatcher";
import type { Engine } from "../src/engine";
import { serveRpc } from "../src/rpc";
import { streamClientTransport, streamServerTransport } from "../src/transport/stream";

function makeEngine(db: AteamDb): Engine {
	const ee = new EventEmitter();
	return {
		services: { db, pty: { has: () => false }, mergeQueue: {}, loopRunner: { describe: () => [] } },
		on: (event: string, cb: (p: unknown) => void) => {
			ee.on(event, cb);
			return () => ee.off(event, cb);
		},
		sendTaskUpdated: () => {},
		sendLoopsUpdated: () => {},
	} as unknown as Engine;
}

describe("system:hello handshake", () => {
	it("serverHandshake reports the protocol version + available agents over RPC", async () => {
		const db = createTestDb();
		const engine = makeEngine(db);
		const c2s = new PassThrough();
		const s2c = new PassThrough();
		serveRpc(engine, createDispatcher(engine), streamServerTransport(c2s, s2c));
		const rpc = createRpcClient(streamClientTransport(s2c, c2s));

		const info = await serverHandshake(rpc);
		// The compatibility field a version-skewed client gates on.
		expect(info.protocolVersion).toBe(PROTOCOL_VERSION);
		// The box's installed agents (ids); shape asserted, membership is env-dependent.
		expect(Array.isArray(info.agents)).toBe(true);
	});
});
