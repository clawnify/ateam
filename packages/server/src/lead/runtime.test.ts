import { describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { LeadItem, LeadPermissionAnswer } from "@ateam/protocol";
import { ChatRuntime, type RuntimeOptions } from "./runtime";

class Agent extends EventEmitter {
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	messages: any[] = [];
	killed = false;
	resumeError?: string;
	constructor() {
		super();
		this.stdin.on("data", (d) => {
			for (const line of String(d).trim().split("\n")) {
				const m = JSON.parse(line);
				this.messages.push(m);
				if (!m.method || m.id === undefined || m.method === "session/prompt") continue;
				if (this.resumeError && (m.method === "thread/resume" || m.method === "session/load")) {
					queueMicrotask(() => this.say({ id: m.id, error: { message: this.resumeError } }));
					continue;
				}
				const result =
					m.method === "initialize"
						? { agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } } }
						: m.method === "config/read"
							? { config: { sandbox_mode: "read-only" } }
							: m.method === "thread/start" || m.method === "thread/resume"
								? { thread: { id: "thread" } }
								: m.method === "turn/start"
									? { turn: { id: "turn" } }
									: { sessionId: "session" };
				queueMicrotask(() => this.say({ id: m.id, result }));
			}
		});
	}
	say(m: unknown) {
		this.stdout.write(`${JSON.stringify(m)}\n`);
	}
	kill() {
		this.killed = true;
		return true;
	}
}
function fixture(agent: RuntimeOptions["agent"], extra: Partial<RuntimeOptions> = {}) {
	const proc = new Agent();
	const items: LeadItem[] = [];
	const done: (string | undefined)[] = [];
	const permissions: { id: string; answer: (a: LeadPermissionAnswer) => void }[] = [];
	const runtime = new ChatRuntime({
		agent,
		cwd: "/tmp",
		prompt: "Coordinate tasks",
		auto: false,
		mcp: { url: "http://127.0.0.1:1/mcp", token: "test" },
		allowedTools: ["mcp__ateam_lead__get_board"],
		session: () => {},
		draft: () => {},
		item: (i) => items.push(i),
		done: (e) => done.push(e),
		permission: (id, _text, answer) => permissions.push({ id, answer }),
		spawn: () => proc as unknown as ChildProcess,
		...extra,
	});
	return { proc, runtime, items, done, permissions };
}
const tick = () => new Promise((r) => setTimeout(r, 1));
describe("Chat native runtimes", () => {
	it("resumes Codex with its own id, preserves read-only config, maps tool approval and final text", async () => {
		const f = fixture("codex", { sessionId: "saved-codex" });
		await f.runtime.send("hello");
		const resume = f.proc.messages.find((m) => m.method === "thread/resume");
		expect(resume.params.threadId).toBe("saved-codex");
		expect(resume.params.sandbox).toBe("read-only");
		f.proc.say({
			id: 90,
			method: "mcpServer/elicitation/request",
			params: {
				threadId: "thread",
				serverName: "ateam_lead",
				mode: "form",
				_meta: { codex_approval_kind: "mcp_tool_call", tool_name: "get_board" },
			},
		});
		expect(f.proc.messages.at(-1).result.action).toBe("accept");
		f.proc.say({
			id: 91,
			method: "mcpServer/elicitation/request",
			params: {
				threadId: "thread",
				serverName: "other",
				mode: "form",
				message: "Allow?",
				_meta: { codex_approval_kind: "mcp_tool_call", tool_name: "get_board" },
			},
		});
		expect(f.permissions).toHaveLength(1);
		f.permissions[0]!.answer("deny");
		expect(f.proc.messages.at(-1).result.action).toBe("decline");
		f.proc.say({
			method: "item/completed",
			params: { threadId: "thread", item: { type: "agentMessage", text: "done" } },
		});
		f.proc.say({ method: "turn/completed", params: { threadId: "thread", turn: {} } });
		expect(f.items.at(-1)).toMatchObject({ kind: "assistant", text: "done" });
		expect(f.done).toEqual([undefined]);
		f.runtime.close();
	});
	it("does not approve a request belonging to another Codex thread", async () => {
		const f = fixture("codex");
		await f.runtime.send("hello");
		f.proc.say({
			id: 90,
			method: "item/fileChange/requestApproval",
			params: { threadId: "elsewhere" },
		});
		expect(f.permissions).toHaveLength(0);
		expect(f.proc.messages.at(-1).error.code).toBe(-32602);
		f.runtime.close();
	});
	it("sets Codex Auto on the turn, and cancels via native interrupt", async () => {
		const f = fixture("codex", { auto: true });
		await f.runtime.send("hello");
		expect(f.proc.messages.find((m) => m.method === "turn/start").params.approvalsReviewer).toBe(
			"auto_review",
		);
		f.runtime.interrupt();
		expect(f.proc.messages.at(-1).method).toBe("turn/interrupt");
		f.runtime.close();
		await tick();
	});
	it("loads OpenCode with the MCP endpoint, surfaces permissions and streams to completion", async () => {
		const f = fixture("opencode", { sessionId: "session" });
		const sending = f.runtime.send("hello");
		await tick();
		expect(
			f.proc.messages.find((m) => m.method === "session/load").params.mcpServers[0].headers[0]
				.value,
		).toBe("Bearer test");
		f.proc.say({
			id: 88,
			method: "session/request_permission",
			params: {
				sessionId: "session",
				toolCall: { title: "Read outside?" },
				options: [
					{ kind: "allow_once", optionId: "yes" },
					{ kind: "reject_once", optionId: "no" },
				],
			},
		});
		expect(f.permissions).toHaveLength(1);
		f.permissions[0]!.answer("deny");
		expect(f.proc.messages.at(-1).result.outcome.optionId).toBe("no");
		f.proc.say({
			method: "session/update",
			params: {
				sessionId: "session",
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } },
			},
		});
		const prompt = f.proc.messages.find((m) => m.method === "session/prompt");
		f.proc.say({ id: prompt.id, result: { stopReason: "end_turn" } });
		await sending;
		expect(f.items.at(-1)).toMatchObject({ kind: "assistant", text: "answer" });
		expect(f.done).toEqual([undefined]);
		f.runtime.close();
	});
	it("OpenCode Auto chooses allow_once only for its own session", async () => {
		const f = fixture("opencode", { auto: true });
		const sending = f.runtime.send("hello");
		await tick();
		for (const sessionId of ["session", "other"])
			f.proc.say({
				id: 80,
				method: "session/request_permission",
				params: { sessionId, options: [{ kind: "allow_once", optionId: "yes" }] },
			});
		const replies = f.proc.messages.filter((m) => m.id === 80);
		expect(replies[0].result.outcome.optionId).toBe("yes");
		expect(replies[1].result.outcome.outcome).toBe("cancelled");
		const prompt = f.proc.messages.find((m) => m.method === "session/prompt");
		f.proc.say({ id: prompt.id, result: {} });
		await sending;
		f.runtime.close();
	});
	it("rejects pending work when its process dies", async () => {
		const f = fixture("opencode");
		const sending = f.runtime.send("hello");
		await tick();
		f.proc.emit("exit", 1);
		await expect(sending).rejects.toThrow("stopped");
		expect(f.done[0]).toContain("exited");
	});
});

it("recovers a missing Codex session once with saved history, without treating auth failures as missing sessions", async () => {
	const f = fixture("codex", { sessionId: "gone", historyPath: "/tmp/synthetic-history.jsonl" });
	f.proc.resumeError = "thread not found";
	await f.runtime.send("hello");
	expect(f.proc.messages.some((m) => m.method === "thread/start")).toBe(true);
	expect(f.proc.messages.find((m) => m.method === "turn/start").params.input[0].text).toContain(
		"/tmp/synthetic-history.jsonl",
	);
	f.runtime.close();
	const auth = fixture("codex", { sessionId: "exists" });
	auth.proc.resumeError = "Please sign in";
	await expect(auth.runtime.send("hello")).rejects.toThrow("sign in");
	expect(auth.proc.messages.some((m) => m.method === "thread/start")).toBe(false);
	auth.runtime.close();
});

it("stopping during startup cannot launch a later prompt", async () => {
	const f = fixture("opencode");
	const sending = f.runtime.send("hello");
	expect(f.runtime.interrupt()).toBe(false);
	f.runtime.close();
	await expect(sending).rejects.toThrow("stopped");
	expect(f.proc.messages.some((m) => m.method === "session/prompt")).toBe(false);
});
