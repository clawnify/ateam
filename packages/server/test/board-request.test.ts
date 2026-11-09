import { afterAll, beforeAll, expect, it } from "bun:test";
import { peerToken, verifyPeerToken } from "../src/agent-setup";
import type { BoardHandlers } from "../src/hooks/board-mcp";
import { HookServer } from "../src/hooks/hook-server";

/**
 * The board's /mcp is the witness that an agent has the board tools
 * (board-connections.ts): the REAL hook server says so for a request carrying
 * the terminal's own token, and only for that one.
 */

const SECRET = "test-secret";
let server: HookServer;
const seen: string[] = [];

beforeAll(async () => {
	server = new HookServer();
	server.setPeerInbox({
		verify: (terminalId, token) => verifyPeerToken(SECRET, terminalId, token),
		wait: () => ({ result: Promise.resolve({ kind: "gone" }), cancel: () => {} }),
		waitUser: () => ({ result: Promise.resolve({ kind: "gone" }), cancel: () => {} }),
		ackUser: () => false,
	});
	// initialize never reaches a handler.
	server.setBoardHandlers({} as BoardHandlers);
	server.on("boardRequest", (terminalId: string) => seen.push(terminalId));
	await server.start();
});

afterAll(() => server.stop());

const initialize = (headers: Record<string, string>) =>
	fetch(`http://127.0.0.1:${server.port}/mcp`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18" },
		}),
	});

it("counts a request with the terminal's own token, and not one without it", async () => {
	const ok = await initialize({
		"x-ateam-terminal-id": "term-1",
		"x-ateam-terminal-token": peerToken(SECRET, "term-1"),
	});
	expect(ok.status).toBe(200);
	// No token (a Codex that never sent env_http_headers), and a wrong one.
	await initialize({ "x-ateam-terminal-id": "term-2" });
	await initialize({ "x-ateam-terminal-id": "term-3", "x-ateam-terminal-token": "nope" });
	expect(seen).toEqual(["term-1"]);
});
