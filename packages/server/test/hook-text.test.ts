import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureNotifyScript } from "../src/agent-setup";
import { type HookEvent, HookServer, hookSessionId, hookText } from "../src/hooks/hook-server";

/**
 * The turn's text reaches the engine: the REAL shipped notify.sh, fired the way
 * Claude Code fires it (event in argv, the hook's JSON on stdin), against the
 * REAL hook server. What the board classifier reads is whatever lands here.
 */

let dir: string;
let scriptPath: string;
let server: HookServer;
let events: HookEvent[] = [];
let followUp: string | undefined;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "ateam-hooktext-"));
	scriptPath = await ensureNotifyScript(dir);
	server = new HookServer();
	server.on("hook", (e: HookEvent) => events.push(e));
	server.setFollowUpResolver(() => followUp);
	await server.start();
});

afterAll(async () => {
	server.stop();
	await rm(dir, { recursive: true, force: true });
});

async function fire(event: string, payload: unknown): Promise<{ events: HookEvent[]; stdout: string }> {
	events = [];
	const proc = Bun.spawn(["sh", scriptPath, event], {
		env: { ...process.env, ATEAM_HOOK_PORT: String(server.port), ATEAM_TERMINAL_ID: "term-1" },
		stdin: new TextEncoder().encode(JSON.stringify(payload)),
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	await proc.exited;
	return { events, stdout };
}

describe("notify.sh → hook server", () => {
	it("carries a Stop's last_assistant_message", async () => {
		const msg = 'Two options: "Postgres" or SQLite?\nWhich one?';
		const { events } = await fire("Stop", { hook_event_name: "Stop", last_assistant_message: msg });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ terminalId: "term-1", eventType: "Stop", lastAssistantMessage: msg });
	});

	it("carries a user reply's prompt", async () => {
		const { events } = await fire("UserReply", { hook_event_name: "UserPromptSubmit", prompt: "use sqlite" });
		expect(events[0]).toMatchObject({ eventType: "UserReply", prompt: "use sqlite" });
	});

	it("sends nothing but the event for a tool call", async () => {
		const { events } = await fire("Working", { tool_input: { command: "ls" }, prompt: "not a reply" });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ terminalId: "term-1", eventType: "Working" });
		expect(events[0].lastAssistantMessage).toBeUndefined();
		expect(events[0].prompt).toBeUndefined();
	});

	it("still echoes an armed follow-up back to the agent on a POSTed Stop", async () => {
		followUp = "keep going";
		const { stdout } = await fire("Stop", { last_assistant_message: "done" });
		followUp = undefined;
		expect(JSON.parse(stdout)).toEqual({ decision: "block", reason: "keep going" });
	});
});

// Codex names its own conversations, and its turn-end `notify` (argv, not
// stdin) is all it reports in a worktree whose hooks it was never asked to
// trust. The field names are the ones in the Codex 0.165 binary.
describe("the conversation id reaches the engine", () => {
	async function fireCodex(payload: unknown): Promise<HookEvent[]> {
		events = [];
		const notify = join(dirname(scriptPath), "codex-notify.sh");
		const proc = Bun.spawn(["sh", notify, JSON.stringify(payload)], {
			env: { ...process.env, ATEAM_HOOK_PORT: String(server.port), ATEAM_TERMINAL_ID: "term-1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
		return events;
	}

	it("from Codex's notify payload", async () => {
		const got = await fireCodex({
			type: "agent-turn-complete",
			"thread-id": "01a1b0f8-7cc0-7542-abb1-24a79ea21a78",
			"turn-id": "t-1",
			cwd: "/w",
			"input-messages": ["go"],
			"last-assistant-message": "done",
		});
		expect(got).toHaveLength(1);
		expect(got[0]).toMatchObject({
			eventType: "Stop",
			sessionId: "01a1b0f8-7cc0-7542-abb1-24a79ea21a78",
			lastAssistantMessage: "done",
		});
	});

	it("from a hook's session_id, which notify.sh's empty query param no longer hides", async () => {
		const { events } = await fire("Stop", { session_id: "sess-7", last_assistant_message: "ok" });
		expect(events[0]).toMatchObject({ eventType: "Stop", sessionId: "sess-7" });
	});

	it("is absent from a bodiless event", async () => {
		const { events } = await fire("Working", { session_id: "sess-7" });
		expect(events[0].sessionId).toBeUndefined();
	});
});

describe("hookSessionId", () => {
	it("reads either schema and nothing else", () => {
		expect(hookSessionId(JSON.stringify({ "thread-id": "th-1" }))).toBe("th-1");
		expect(hookSessionId(JSON.stringify({ session_id: "s-1" }))).toBe("s-1");
		expect(hookSessionId(JSON.stringify({ "thread-id": "  " }))).toBeUndefined();
		expect(hookSessionId(JSON.stringify({ "thread-id": 7 }))).toBeUndefined();
		expect(hookSessionId("not json")).toBeUndefined();
		expect(hookSessionId("")).toBeUndefined();
	});
});

describe("hookText", () => {
	it("reads Codex's notify payload too", () => {
		expect(
			hookText(
				JSON.stringify({
					type: "agent-turn-complete",
					"last-assistant-message": "Ready for review",
					"input-messages": ["first", "fix the tests"],
				}),
			),
		).toEqual({ lastAssistantMessage: "Ready for review", prompt: "fix the tests" });
	});

	it("yields nothing for a body that is not a hook's JSON", () => {
		expect(hookText("")).toEqual({});
		expect(hookText("not json")).toEqual({});
		expect(hookText(JSON.stringify({ last_assistant_message: "   " }))).toEqual({});
	});
});
