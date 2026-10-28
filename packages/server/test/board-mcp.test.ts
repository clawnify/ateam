import { describe, expect, it } from "bun:test";
import {
	BOARD_INSTRUCTIONS,
	type BoardHandlers,
	dispatchMcp,
	parseUntil,
} from "../src/hooks/board-mcp";

// A fake board that records what it was called with.
function fakeBoard() {
	const calls: {
		setStatus: unknown[];
		setWaiting: unknown[];
		sendMessage: unknown[];
		askUser: unknown[];
	} = {
		setStatus: [],
		setWaiting: [],
		sendMessage: [],
		askUser: [],
	};
	const board: BoardHandlers = {
		get: async () => ({ tasks: [{ taskId: "t1" }] }),
		setStatus: async (req) => {
			calls.setStatus.push(req);
			return { ok: true, reason: `moved ${req.taskId}` };
		},
		setWaiting: async (req) => {
			calls.setWaiting.push(req);
			return { ok: true, reason: `parked ${req.taskId}` };
		},
		listPeers: async () => [{ taskId: "t2", name: "other" }],
		sendMessage: async (req) => {
			calls.sendMessage.push(req);
			return { ok: true, reason: `sent to ${req.to}` };
		},
		askUser: async (req) => {
			calls.askUser.push(req);
			return { ok: true, reason: "asked" };
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
			// Agents list MCP tools by name only, so this is how a session learns it has peers.
			expect(body.result).toHaveProperty("instructions", BOARD_INSTRUCTIONS);
		}
	});

	it("acknowledges the initialized notification with 202 (no reply)", async () => {
		const { board } = fakeBoard();
		const r = await dispatchMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, board);
		expect(r.kind).toBe("accepted");
	});

	it("tools/list returns the board tools and the peer tools", async () => {
		const { board } = fakeBoard();
		const r = await dispatchMcp(rpc("tools/list"), board);
		if (r.kind === "json") {
			const names = (r.body as { result: { tools: { name: string }[] } }).result.tools.map(
				(t) => t.name,
			);
			expect(names).toEqual([
				"get_board",
				"set_status",
				"set_waiting",
				"list_peers",
				"send_message",
				"ask_user",
			]);
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

describe("set_waiting", () => {
	it("parses the ISO date and hands the caller's terminal to the board, taskId optional", async () => {
		const { board, calls } = fakeBoard();
		const r = await dispatchMcp(
			rpc("tools/call", {
				name: "set_waiting",
				arguments: { reason: "Twilio approval", until: "2030-01-02T09:00:00Z" },
			}),
			board,
			{ callerTerminalId: "term-1" },
		);
		expect(r.kind).toBe("json");
		expect(calls.setWaiting).toEqual([
			{
				taskId: undefined,
				reason: "Twilio approval",
				until: Date.parse("2030-01-02T09:00:00Z"),
				callerTerminalId: "term-1",
			},
		]);
	});

	it("refuses a date it cannot read without touching the board", async () => {
		const { board, calls } = fakeBoard();
		const r = await dispatchMcp(
			rpc("tools/call", {
				name: "set_waiting",
				arguments: { taskId: "t1", reason: "x", until: "next tuesday" },
			}),
			board,
		);
		if (r.kind !== "json") throw new Error("expected json");
		expect((r.body as { result: { isError: boolean } }).result.isError).toBe(true);
		expect(calls.setWaiting).toEqual([]);
	});
});

describe("parseUntil", () => {
	it("reads a bare date as 09:00 local, not UTC midnight", () => {
		const ms = parseUntil("2030-03-04");
		expect(ms).not.toBeNull();
		const d = new Date(ms as number);
		expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2030, 2, 4, 9]);
	});
	it("passes a full timestamp through and rejects junk", () => {
		expect(parseUntil("2030-03-04T10:30:00Z")).toBe(Date.parse("2030-03-04T10:30:00Z"));
		expect(parseUntil("soon")).toBeNull();
		expect(parseUntil("")).toBeNull();
	});
});

describe("peer tools", () => {
	const call = (name: string, args: unknown = {}) => rpc("tools/call", { name, arguments: args });
	const text = (r: Awaited<ReturnType<typeof dispatchMcp>>) =>
		r.kind === "json"
			? (r.body as { result: { content: { text: string }[]; isError: boolean } }).result
			: undefined;

	// The terminal-id header alone is a claim any local process can make.
	it("refuse a caller without a verified Ateam token", async () => {
		const { board, calls } = fakeBoard();
		for (const ctx of [
			{},
			{ callerTerminalId: "term-1" },
			{ callerTerminalId: "term-1", callerVerified: false },
		]) {
			const r = text(
				await dispatchMcp(call("send_message", { to: "t2", message: "hi" }), board, ctx),
			);
			expect(r?.isError).toBe(true);
			expect(text(await dispatchMcp(call("list_peers"), board, ctx))?.isError).toBe(true);
		}
		expect(calls.sendMessage).toHaveLength(0);
	});

	it("send_message passes the verified caller as the sender", async () => {
		const { board, calls } = fakeBoard();
		const ctx = { callerTerminalId: "term-1", callerVerified: true };
		const r = text(
			await dispatchMcp(call("send_message", { to: "t2", message: "hi" }), board, ctx),
		);
		expect(r?.isError).toBe(false);
		expect(calls.sendMessage).toEqual([{ fromTerminalId: "term-1", to: "t2", body: "hi" }]);
		const peers = text(await dispatchMcp(call("list_peers"), board, ctx));
		expect(peers?.content[0]?.text).toContain('"t2"');
	});
});

describe("ask_user", () => {
	const ask = (args: unknown) => rpc("tools/call", { name: "ask_user", arguments: args });

	it("files the question for the verified caller's task", async () => {
		const { board, calls } = fakeBoard();
		const r = await dispatchMcp(
			ask({ question: "Deploy to prod?", options: ["Deploy", "Wait"], allowText: false }),
			board,
			{ callerTerminalId: "term-1", callerVerified: true },
		);
		expect(r.kind === "json" && (r.body as { result: { isError: boolean } }).result.isError).toBe(
			false,
		);
		expect(calls.askUser).toEqual([
			{
				callerTerminalId: "term-1",
				text: "Deploy to prod?",
				options: ["Deploy", "Wait"],
				allowText: false,
			},
		]);
	});

	it("is refused to a caller without a valid terminal token", async () => {
		const { board, calls } = fakeBoard();
		const r = await dispatchMcp(ask({ question: "x" }), board, { callerTerminalId: "term-1" });
		expect(r.kind === "json" && (r.body as { result: { isError: boolean } }).result.isError).toBe(
			true,
		);
		expect(calls.askUser).toHaveLength(0);
	});
});
