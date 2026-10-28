import { describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CH } from "@ateam/protocol";
import type { LeadEvent } from "../../shared/lead";
import { LeadSession } from "./session";
import { createLeadTools } from "./tools";

// ---- tools, against a fake router -------------------------------------------

const TASKS = [
	{
		id: "t1",
		projectId: "p1",
		name: "fix login",
		branch: "fix-login",
		column: "review",
		agentId: "claude",
		agentStatus: "idle",
		agentIds: ["claude"],
		description: "Fix the redirect loop",
		waitingReason: null,
	},
	{
		id: "t2",
		projectId: "p1",
		name: "old work",
		branch: "old",
		column: "merged",
		agentId: "codex",
		agentStatus: null,
		agentIds: [],
		description: null,
		waitingReason: null,
	},
];

function fakeRouter(overrides: Record<string, (args: unknown[]) => unknown> = {}) {
	const calls: { method: string; args: unknown[] }[] = [];
	const handle = async (method: string, args: unknown[]) => {
		calls.push({ method, args });
		if (overrides[method]) return overrides[method](args);
		if (method === CH.projectsList) return [{ id: "p1", name: "ateam" }];
		if (method === CH.tasksList) return TASKS;
		if (method === CH.settingsGet) return { settings: { engine: { defaultAgentId: "claude" } } };
		if (method === CH.tasksCreate)
			return { ...TASKS[0], id: "00000000-0000-4000-8000-000000000001", name: "new" };
		if (method === CH.ptySpawnAgent) return { terminalId: "term" };
		throw new Error(`unexpected ${method}`);
	};
	return { calls, handle };
}

describe("lead tools", () => {
	it("get_board leaves merged tasks out and names the machine", async () => {
		const r = fakeRouter();
		const tools = createLeadTools({ handle: r.handle, machineOf: () => "hetzner" });
		const res = await tools.call("get_board", {});
		const view = JSON.parse(res?.text ?? "");
		expect(view[0].machine).toBe("hetzner");
		expect(view[0].tasks.map((t: { name: string }) => t.name)).toEqual(["fix login"]);
		expect(view[0].tasks[0].state).toBe("idle");
	});

	it("create_task creates on the project, then starts the default agent with the prompt", async () => {
		const r = fakeRouter();
		const tools = createLeadTools({ handle: r.handle, machineOf: () => null });
		const res = await tools.call("create_task", { project: "ateam", name: "new", prompt: "do it" });
		expect(res?.isError).toBeFalsy();
		expect(res?.text).toContain("(00000000-0000-4000-8000-000000000001)");
		const create = r.calls.find((c) => c.method === CH.tasksCreate);
		expect(create?.args[0]).toEqual({ projectId: "p1", name: "new", agentId: "claude" });
		const spawn = r.calls.find((c) => c.method === CH.ptySpawnAgent);
		expect(spawn?.args[0]).toMatchObject({ agentId: "claude", prompt: "do it", yolo: false });
	});

	it("send_message resolves a task by name and routes by its id", async () => {
		const r = fakeRouter({ [CH.peersSendFromLead]: () => ({ ok: true, reason: "sent" }) });
		const tools = createLeadTools({ handle: r.handle, machineOf: () => null });
		const res = await tools.call("send_message", { task: "Fix Login", message: "rebase" });
		expect(res).toEqual({ text: "sent", isError: false });
		const send = r.calls.find((c) => c.method === CH.peersSendFromLead);
		expect(send?.args[0]).toEqual({ taskId: "t1", body: "rebase" });
	});

	it("says a box needs an update when its engine predates the Lead", async () => {
		const r = fakeRouter({
			[CH.peersSendFromLead]: () => {
				throw new Error("Unknown method: peers:sendFromLead");
			},
		});
		const tools = createLeadTools({ handle: r.handle, machineOf: () => "box" });
		const res = await tools.call("send_message", { task: "t1", message: "x" });
		expect(res?.isError).toBe(true);
		expect(res?.text).toContain("update the box");
	});

	it("read_task includes the last reply", async () => {
		const r = fakeRouter({ [CH.tasksLastReply]: () => ({ text: "Done, tests pass.", at: 0 }) });
		const tools = createLeadTools({ handle: r.handle, machineOf: () => null });
		const view = JSON.parse((await tools.call("read_task", { task: "t1" }))?.text ?? "");
		expect(view.lastReply.text).toBe("Done, tests pass.");
		expect(view.asked).toBe("Fix the redirect loop");
	});

	it("answers null for a tool it does not have", async () => {
		const tools = createLeadTools({ handle: fakeRouter().handle, machineOf: () => null });
		expect(await tools.call("nope", {})).toBeNull();
	});
});

// ---- session, against a fake claude process ---------------------------------

class FakeClaude extends EventEmitter {
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	written: Record<string, unknown>[] = [];
	killed = false;
	constructor(public args: string[]) {
		super();
		this.stdin.on("data", (d: Buffer) => {
			for (const line of d.toString().split("\n")) if (line) this.written.push(JSON.parse(line));
		});
	}
	say(...lines: unknown[]) {
		for (const l of lines) this.stdout.write(`${JSON.stringify(l)}\n`);
	}
	kill() {
		this.killed = true;
		return true;
	}
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function makeSession(dir = mkdtempSync(join(tmpdir(), "lead-"))) {
	const procs: FakeClaude[] = [];
	const events: LeadEvent[] = [];
	const session = new LeadSession({
		dir,
		mcp: { url: "http://127.0.0.1:1/mcp", token: "tok" },
		allowedTools: ["mcp__ateam_lead__get_board"],
		emit: (e) => events.push(e),
		spawnClaude: (args) => {
			const p = new FakeClaude(args);
			procs.push(p);
			return p as unknown as ChildProcess;
		},
	});
	return { session, procs, events, dir };
}

const init = (id = "sess-1") => ({ type: "system", subtype: "init", session_id: id });

describe("LeadSession", () => {
	it("starts claude on the first message and renders a turn with a tool call", async () => {
		const { session, procs, dir } = makeSession();
		expect(procs).toHaveLength(0);
		session.send("what's on the board?");
		const p = procs[0] as FakeClaude;
		expect(p.args).toContain("--session-id");
		expect(p.args).not.toContain("--safe-mode");
		await tick();
		expect(p.written[0]).toMatchObject({ type: "user", message: { content: "what's on the board?" } });
		expect(session.snapshot().busy).toBe(true);

		p.say(
			init(),
			{ type: "stream_event", event: { type: "message_start" } },
			{ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Let me " } } },
		);
		await tick();
		expect(session.snapshot().draft).toBe("Let me ");
		p.say(
			{
				type: "assistant",
				message: { content: [{ type: "tool_use", id: "tu1", name: "mcp__ateam_lead__get_board", input: {} }] },
			},
			{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "[]" }] }] } },
			{ type: "assistant", message: { content: [{ type: "text", text: "The board is empty." }] } },
			{ type: "result", subtype: "success" },
		);
		await tick();
		const snap = session.snapshot();
		expect(snap.busy).toBe(false);
		expect(snap.draft).toBe("");
		expect(snap.items.map((i) => i.kind)).toEqual(["user", "tool", "assistant"]);
		expect(snap.items[1]).toMatchObject({ name: "get_board", result: "[]", isError: false });
		expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).sessionId).toBe("sess-1");

		// A restart replays the transcript and resumes the same conversation.
		const again = makeSession(dir);
		expect(again.session.snapshot().items).toHaveLength(3);
		again.session.send("and now?");
		const args = (again.procs[0] as FakeClaude).args;
		expect(args[args.indexOf("--resume") + 1]).toBe("sess-1");
	});

	it("interrupts a turn without ending the process", async () => {
		const { session, procs } = makeSession();
		session.send("long job");
		const p = procs[0] as FakeClaude;
		p.say(init());
		await tick();
		session.interrupt();
		await tick();
		expect(p.written.at(-1)).toMatchObject({ type: "control_request", request: { subtype: "interrupt" } });
		p.say({ type: "result", subtype: "error_during_execution" });
		await tick();
		const last = session.snapshot().items.at(-1);
		expect(last).toMatchObject({ kind: "notice", text: "Stopped.", tone: "info" });
		expect(p.killed).toBe(false);
	});

	it("starts fresh, replaying the message, when the saved conversation can't be resumed", async () => {
		const first = makeSession();
		first.session.send("hi");
		(first.procs[0] as FakeClaude).say(init("gone"));
		await tick();
		first.session.dispose();

		const { session, procs } = makeSession(first.dir);
		session.send("hello again");
		const stale = procs[0] as FakeClaude;
		expect(stale.args).toContain("--resume");
		await tick();
		stale.emit("exit", 1);
		await tick();
		const fresh = procs[1] as FakeClaude;
		expect(fresh.args).toContain("--session-id");
		expect(fresh.written[0]).toMatchObject({ message: { content: "hello again" } });
		expect(session.snapshot().items.at(-1)).toMatchObject({ kind: "notice" });
	});

	it("reports a crash mid-turn, and ignores the exit of a process it killed", async () => {
		const { session, procs } = makeSession();
		session.send("hi");
		const p = procs[0] as FakeClaude;
		p.say(init());
		p.stderr.write("boom\n");
		await tick();
		p.emit("exit", 1);
		await tick();
		expect(session.snapshot()).toMatchObject({ busy: false });
		expect(session.snapshot().items.at(-1)).toMatchObject({ kind: "notice", tone: "error" });

		session.send("again");
		const q = procs[1] as FakeClaude;
		session.reset();
		q.emit("exit", 0);
		await tick();
		expect(session.snapshot().items).toHaveLength(0);
	});
});
