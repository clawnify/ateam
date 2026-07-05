import { describe, expect, it } from "bun:test";
import { type BoardHandlers, dispatchMcp } from "../src/hooks/board-mcp";

// A fake board that records what it was called with.
function fakeBoard() {
	const calls: { setStatus: unknown[] } = { setStatus: [] };
	const board: BoardHandlers = {
		get: async () => ({ tasks: [{ taskId: "t1" }] }),
		setStatus: async (req) => {
			calls.setStatus.push(req);
			return { ok: true, reason: `moved ${req.taskId}` };
		},
	};
	return { board, calls };
}

const rpc = (method: string, params?: unknown, id: number | null = 1) => ({
	jsonrpc: "2.0" as const,
	id,
	method,
	params,
});

describe("dispatchMcp", () => {
	it("initialize echoes the client protocol version and advertises tools", async () => {
		const { board } = fakeBoard();
		const r = await dispatchMcp(rpc("initialize", { protocolVersion: "2025-06-18" }), board);
		expect(r.kind).toBe("json");
		if (r.kind === "json") {
			const body = r.body as { result: { protocolVersion: string; capabilities: unknown } };
			expect(body.result.protocolVersion).toBe("2025-06-18");
			expect(body.result.capabilities).toHaveProperty("tools");
		}
	});

	it("acknowledges the initialized notification with 202 (no reply)", async () => {
		const { board } = fakeBoard();
		const r = await dispatchMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, board);
		expect(r.kind).toBe("accepted");
	});

	it("tools/list returns get_board and set_status", async () => {
		const { board } = fakeBoard();
		const r = await dispatchMcp(rpc("tools/list"), board);
		if (r.kind === "json") {
			const names = (r.body as { result: { tools: { name: string }[] } }).result.tools.map(
				(t) => t.name,
			);
			expect(names).toEqual(["get_board", "set_status"]);
		}
	});

	it("set_status only offers the assignable columns in its schema", async () => {
		const { board } = fakeBoard();
		const r = await dispatchMcp(rpc("tools/list"), board);
		if (r.kind === "json") {
			const set = (
				r.body as {
					result: {
						tools: { name: string; inputSchema: { properties: { to: { enum: string[] } } } }[];
					};
				}
			).result.tools.find((t) => t.name === "set_status");
			expect(set?.inputSchema.properties.to.enum).toEqual(["todo", "review"]);
		}
	});

	it("tools/call get_board returns the board JSON as text content", async () => {
		const { board } = fakeBoard();
		const r = await dispatchMcp(rpc("tools/call", { name: "get_board", arguments: {} }, 2), board);
		if (r.kind === "json") {
			const result = (r.body as { result: { content: { type: string; text: string }[] } }).result;
			expect(result.content[0].type).toBe("text");
			expect(result.content[0].text).toContain("t1");
		}
	});

	it("tools/call set_status threads the caller terminal id through as a self-move", async () => {
		const { board, calls } = fakeBoard();
		await dispatchMcp(
			rpc("tools/call", { name: "set_status", arguments: { taskId: "t1", to: "review" } }, 3),
			board,
			{ callerTerminalId: "term-9" },
		);
		expect(calls.setStatus[0]).toMatchObject({
			taskId: "t1",
			to: "review",
			callerTerminalId: "term-9",
		});
	});

	it("set_status requires taskId and to", async () => {
		const { board } = fakeBoard();
		const r = await dispatchMcp(rpc("tools/call", { name: "set_status", arguments: {} }, 4), board);
		if (r.kind === "json") {
			const result = (r.body as { result: { isError: boolean } }).result;
			expect(result.isError).toBe(true);
		}
	});

	it("unknown method → JSON-RPC method-not-found", async () => {
		const { board } = fakeBoard();
		const r = await dispatchMcp(rpc("frobnicate"), board);
		if (r.kind === "json") {
			expect((r.body as { error: { code: number } }).error.code).toBe(-32601);
		}
	});

	it("unknown tool → invalid params error", async () => {
		const { board } = fakeBoard();
		const r = await dispatchMcp(rpc("tools/call", { name: "nope", arguments: {} }, 5), board);
		if (r.kind === "json") {
			expect((r.body as { error: { code: number } }).error.code).toBe(-32602);
		}
	});
});
