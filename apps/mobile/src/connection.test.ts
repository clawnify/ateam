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
import { connect } from "./connection";

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
