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
		if (method === CH.projectsList)
			return [
				{
					id: "p1",
					name: "ateam",
					repoPath: "/Users/me/Codes/ateam",
					githubOwner: "clawnify",
					githubName: "ateam",
				},
			];
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
	it("get_board leaves merged tasks out and names the repo and the machine", async () => {
		const r = fakeRouter();
		const tools = createLeadTools({ handle: r.handle, machineOf: () => "hetzner" });
		const res = await tools.call("get_board", {});
		const text = res?.text ?? "";
		expect(text).toContain("ateam (repo clawnify/ateam, hetzner, project p1)");
		expect(text).toContain("t1 | fix login | review | idle | claude");
		expect(text).not.toContain("old work");
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

	it("create_task sends attached files to the project's machine before the task exists", async () => {
		const r = fakeRouter();
		const delivered: { owner: string; paths: string[] }[] = [];
		const tools = createLeadTools({
			handle: r.handle,
			machineOf: () => "hetzner",
			files: {
				resolve: (paths) =>
					paths.every((p) => p.startsWith("/att/")) ? paths : "not attached in this chat",
				deliver: async (owner, paths) => {
					delivered.push({ owner, paths });
					return { paths: paths.map((p) => `/box${p}`) };
				},
			},
		});
		const res = await tools.call("create_task", {
			project: "ateam",
			name: "new",
			prompt: "fix what the screenshot shows",
			files: ["/att/1/shot.png"],
		});
		expect(res?.isError).toBeFalsy();
		expect(res?.text).toContain("working on your prompt. It has 1 attached file.");
		expect(delivered).toEqual([{ owner: "p1", paths: ["/att/1/shot.png"] }]);
		const spawn = r.calls.find((c) => c.method === CH.ptySpawnAgent);
		expect(spawn?.args[0]).toMatchObject({ files: ["/box/att/1/shot.png"] });
	});

	it("create_task starts nothing when a file isn't attached here or can't reach the box", async () => {
		const r = fakeRouter();
		const files = {
			resolve: (paths: string[]) =>
				paths.every((p) => p.startsWith("/att/")) ? paths : "not attached in this chat",
			deliver: async () => ({ error: "big.mov is 40 MB" }),
		};
		const tools = createLeadTools({ handle: r.handle, machineOf: () => null, files });
		const args = { project: "ateam", name: "new", prompt: "x" };
		const outside = await tools.call("create_task", { ...args, files: ["/Users/me/.ssh/id"] });
		expect(outside).toEqual({ text: "not attached in this chat", isError: true });
		const tooBig = await tools.call("create_task", { ...args, files: ["/att/1/big.mov"] });
		expect(tooBig).toEqual({ text: "big.mov is 40 MB", isError: true });
		expect(r.calls.some((c) => c.method === CH.tasksCreate)).toBe(false);
	});

	it("send_message lists attached files under the message, as the task's machine sees them", async () => {
		const r = fakeRouter({ [CH.peersSendFromLead]: () => ({ ok: true, reason: "sent" }) });
		const tools = createLeadTools({
			handle: r.handle,
			machineOf: () => null,
			files: {
				resolve: (paths) => paths,
				deliver: async (owner, paths) => ({ paths: paths.map((p) => `${owner}:${p}`) }),
			},
		});
		await tools.call("send_message", {
			task: "t1",
			message: "see spec ",
			files: ["/att/spec.pdf"],
		});
		const send = r.calls.find((c) => c.method === CH.peersSendFromLead);
		expect(send?.args[0]).toEqual({
			taskId: "t1",
			body: "see spec\n\nAttached files:\n- t1:/att/spec.pdf",
		});
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

	it("shows a pending question and passes the user's answer to it", async () => {
		const question = {
			id: "q1",
			text: "Deploy?",
			options: ["Deploy", "Wait"],
			allowText: false,
			askedAt: 0,
		};
		const asked = TASKS.map((t) => (t.id === "t1" ? { ...t, question } : t));
		const r = fakeRouter({ [CH.tasksList]: () => asked, [CH.tasksAnswerQuestion]: () => ({}) });
		const tools = createLeadTools({ handle: r.handle, machineOf: () => null });
		const board = (await tools.call("get_board", {}))?.text ?? "";
		expect(board).toContain("asks the user: Deploy?");
		const res = await tools.call("answer_question", { task: "fix login", answer: "Wait" });
		expect(res?.isError).toBeFalsy();
		const sent = r.calls.find((c) => c.method === CH.tasksAnswerQuestion);
		expect(sent?.args[0]).toEqual({ taskId: "t1", questionId: "q1", via: "lead", answer: "Wait" });
	});

	it("says what a task proposes, on the board and in read_task", async () => {
		const proposals = [
			{
				id: "p1",
				kind: "task",
				name: "Fix flaky test",
				prompt: "Find why it flakes.",
				reason: "Seen twice",
				proposedAt: 0,
			},
			{
				id: "p2",
				kind: "loop",
				name: "Nightly deps",
				prompt: "Check deps.",
				dailyAt: "09:00",
				proposedAt: 0,
			},
		];
		const proposing = TASKS.map((t) =>
			t.id === "t1" ? { ...t, column: "needs_attention", proposals } : t,
		);
		const r = fakeRouter({ [CH.tasksList]: () => proposing, [CH.tasksLastReply]: () => null });
		const tools = createLeadTools({ handle: r.handle, machineOf: () => null });
		const board = (await tools.call("get_board", { filter: "needs_you" }))?.text ?? "";
		expect(board).toContain("proposes: task Fix flaky test; loop Nightly deps");
		const view = JSON.parse((await tools.call("read_task", { task: "t1" }))?.text ?? "");
		expect(view.proposes).toEqual([
			{ kind: "task", name: "Fix flaky test", why: "Seen twice", prompt: "Find why it flakes." },
			{ kind: "loop", name: "Nightly deps", prompt: "Check deps.", schedule: "every day at 09:00" },
		]);
	});

	it("filters the board to what needs the user, in compact rows", async () => {
		const waiting = TASKS.map((t) => (t.id === "t1" ? { ...t, column: "needs_attention" } : t));
		const extra = {
			...TASKS[0],
			id: "t3",
			name: "busy",
			column: "running",
			agentStatus: "running",
		};
		const r = fakeRouter({ [CH.tasksList]: () => [...waiting, extra] });
		const tools = createLeadTools({ handle: r.handle, machineOf: () => null });
		const needs = (await tools.call("get_board", { filter: "needs_you" }))?.text ?? "";
		expect(needs).toContain("t1 | fix login");
		expect(needs).not.toContain("t3 | busy");
		expect(needs).not.toContain("Fix the redirect loop");
		const working = (await tools.call("get_board", { filter: "working" }))?.text ?? "";
		expect(working).toContain("t3 | busy");
		expect(working).not.toContain("t1 | fix login");
	});

	it("lists the latest activity first and says how long ago each task changed", async () => {
		const now = Date.now();
		const tasks = [
			{ ...TASKS[0], id: "t4", name: "made monday", lastEventAt: now - 3 * 86_400_000 },
			{ ...TASKS[0], id: "t5", name: "just finished", lastEventAt: now - 5 * 60_000 },
			{ ...TASKS[0], id: "t6", name: "never ran", lastEventAt: null },
		];
		const r = fakeRouter({ [CH.tasksList]: () => tasks });
		const tools = createLeadTools({ handle: r.handle, machineOf: () => null });
		const rows = ((await tools.call("get_board", {}))?.text ?? "")
			.split("\n")
			.filter((l) => / \| /.test(l));
		expect(rows).toEqual([
			"id | name | column | state | agent | updated",
			"t5 | just finished | review | idle | claude | 5m ago",
			"t4 | made monday | review | idle | claude | 3d ago",
			"t6 | never ran | review | idle | claude | -",
		]);
	});

	it("recent lists the newest tasks across projects, merged ones included", async () => {
		const now = Date.now();
		const byProject: Record<string, unknown[]> = {
			p1: [
				{ ...TASKS[1], id: "a-old", name: "a old", lastEventAt: now - 2 * 86_400_000 },
				{ ...TASKS[1], id: "a-merged", name: "a merged", lastEventAt: now - 2 * 60_000 },
			],
			p2: [
				{ ...TASKS[0], id: "b-new", name: "b new", projectId: "p2", lastEventAt: now - 1_000 },
				{ ...TASKS[0], id: "b-mid", name: "b mid", projectId: "p2", lastEventAt: now - 3_600_000 },
			],
		};
		const r = fakeRouter({
			[CH.projectsList]: () => [
				{
					id: "p1",
					name: "ateam",
					repoPath: "/r/ateam",
					githubOwner: "clawnify",
					githubName: "ateam",
				},
				{ id: "p2", name: "site", repoPath: "/r/site", githubOwner: null, githubName: null },
			],
			[CH.tasksList]: ([projectId]) => byProject[String(projectId)] ?? [],
		});
		const tools = createLeadTools({ handle: r.handle, machineOf: () => null });
		const text = (await tools.call("get_board", { filter: "recent", limit: 3 }))?.text ?? "";
		// The project with the newest task comes first; the oldest task is past the limit.
		expect(text.indexOf("site (")).toBeLessThan(text.indexOf("ateam ("));
		// A project with no GitHub remote names its clone's path as the repo.
		expect(text).toContain("site (repo /r/site, this Mac, project p2)");
		expect(text).toContain("b-new | b new | review | idle | claude | just now");
		expect(text).toContain("a-merged | a merged | merged | not_running | codex | 2m ago");
		expect(text).toContain("b-mid | b mid");
		expect(text).not.toContain("a old");
		// Without recent, merged work stays out.
		const all = (await tools.call("get_board", {}))?.text ?? "";
		expect(all).not.toContain("a merged");
	});

	it("looks a task up by id on its own engine, without listing the board", async () => {
		const id = "11111111-2222-4333-8444-555555555555";
		const r = fakeRouter({
			[CH.tasksGet]: () => ({ ...TASKS[0], id }),
			[CH.peersSendFromLead]: () => ({ ok: true, reason: "sent" }),
		});
		const tools = createLeadTools({ handle: r.handle, machineOf: () => null });
		await tools.call("send_message", { task: id, message: "rebase" });
		expect(r.calls.map((c) => c.method)).toEqual([CH.tasksGet, CH.peersSendFromLead]);
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

/** The control requests the session sent this process, oldest first. */
const controls = (p: FakeClaude) =>
	p.written
		.filter((w) => w.type === "control_request")
		.map((w) => w.request as Record<string, unknown>);

/** Claude answers the latest control request of this kind, or fails it. */
function answer(p: FakeClaude, subtype: string, response: unknown, error?: string) {
	const req = p.written.findLast(
		(w) => w.type === "control_request" && (w.request as { subtype?: string }).subtype === subtype,
	);
	const id = req?.request_id;
	p.say({
		type: "control_response",
		response: error
			? { subtype: "error", request_id: id, error }
			: { subtype: "success", request_id: id, response },
	});
}

describe("LeadSession", () => {
	it("starts claude on the first message and renders a turn with a tool call", async () => {
		const { session, procs, dir } = makeSession();
		expect(procs).toHaveLength(0);
		session.send("what's on the board?");
		const p = procs[0] as FakeClaude;
		expect(p.args).toContain("--session-id");
		expect(p.args).not.toContain("--safe-mode");
		await tick();
		expect(p.written[0]).toMatchObject({
			type: "user",
			message: { content: "what's on the board?" },
		});
		expect(session.snapshot().busy).toBe(true);

		p.say(
			init(),
			{ type: "stream_event", event: { type: "message_start" } },
			{
				type: "stream_event",
				event: { type: "content_block_delta", delta: { type: "text_delta", text: "Let me " } },
			},
		);
		await tick();
		expect(session.snapshot().draft).toBe("Let me ");
		p.say(
			{
				type: "assistant",
				message: {
					content: [{ type: "tool_use", id: "tu1", name: "mcp__ateam_lead__get_board", input: {} }],
				},
			},
			{
				type: "user",
				message: {
					content: [
						{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "[]" }] },
					],
				},
			},
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

	it("tells the Lead where attached files are, and shows them on the message", async () => {
		const { session, procs } = makeSession();
		const file = { path: "/lead/attachments/a/shot.png", name: "shot.png", size: 3, image: true };
		session.send("what is wrong here?", [file]);
		session.send("", [file]);
		await tick();
		const p = procs[0] as FakeClaude;
		expect(p.written[0]).toMatchObject({
			message: {
				content: "what is wrong here?\n\nAttached files:\n- /lead/attachments/a/shot.png",
			},
		});
		expect(p.written[1]).toMatchObject({
			message: { content: "Attached files:\n- /lead/attachments/a/shot.png" },
		});
		const users = session.snapshot().items.filter((i) => i.kind === "user");
		expect(users[0]).toMatchObject({ text: "what is wrong here?", files: [file] });
		session.send("   ");
		expect(session.snapshot().items.filter((i) => i.kind === "user")).toHaveLength(2);
	});

	it("runs as the user's own Claude Code, asking the chat about permissions", () => {
		const { session, procs } = makeSession();
		session.send("hi");
		const args = (procs[0] as FakeClaude).args;
		expect(args).not.toContain("--setting-sources");
		expect(args).not.toContain("--strict-mcp-config");
		expect(args).not.toContain("--tools");
		expect(args[args.indexOf("--permission-prompt-tool") + 1]).toBe("stdio");
		expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__ateam_lead__get_board");
	});

	it("turns a permission prompt into a card and answers it the way Claude reads it", async () => {
		const { session, procs, dir } = makeSession();
		session.send("write the file");
		const p = procs[0] as FakeClaude;
		const ask = (id: string, command: string) => ({
			type: "control_request",
			request_id: id,
			request: {
				subtype: "can_use_tool",
				tool_name: "Bash",
				input: { command },
				permission_suggestions: [
					{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "echo hi *" }] },
				],
			},
		});
		p.say(init(), ask("r1", "echo hi > a.txt"), ask("r2", "echo hi > b.txt"), ask("r3", "rm c"));
		await tick();
		expect(session.snapshot().items.find((i) => i.id === "r1")).toMatchObject({
			kind: "permission",
			canAlways: true,
			always: "Bash(echo hi *)",
		});
		expect(JSON.stringify(session.snapshot().items)).toContain("Run a command?");

		session.answerPermission("r1", "allow");
		session.answerPermission("r2", "always");
		session.answerPermission("r3", "deny");
		await tick();
		const responses = p.written.filter((w) => w.type === "control_response");
		expect(responses).toEqual([
			{
				type: "control_response",
				response: {
					subtype: "success",
					request_id: "r1",
					response: { behavior: "allow", updatedInput: { command: "echo hi > a.txt" } },
				},
			},
			{
				type: "control_response",
				response: {
					subtype: "success",
					request_id: "r2",
					response: {
						behavior: "allow",
						updatedInput: { command: "echo hi > b.txt" },
						updatedPermissions: [
							{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "echo hi *" }] },
						],
					},
				},
			},
			{
				type: "control_response",
				response: {
					subtype: "success",
					request_id: "r3",
					response: { behavior: "deny", message: "The user said no from the Lead chat." },
				},
			},
		]);
		expect(session.snapshot().items.find((i) => i.id === "r2")).toMatchObject({ answer: "always" });
		expect(() => session.answerPermission("r1", "allow")).toThrow("no longer waiting");

		// A prompt still waiting when the app closes is not left waiting after it.
		p.say(ask("r4", "echo late"));
		await tick();
		const again = makeSession(dir);
		expect(again.session.snapshot().items.find((i) => i.id === "r4")).toMatchObject({
			answer: "cancelled",
		});
	});

	it("takes a prompt down when Stop withdraws it, and refuses what it can't answer", async () => {
		const { session, procs } = makeSession();
		session.send("go");
		const p = procs[0] as FakeClaude;
		p.say(init(), {
			type: "control_request",
			request_id: "r1",
			request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "/x" } },
		});
		await tick();
		expect(session.snapshot().items.at(-1)).toMatchObject({ kind: "permission", canAlways: false });
		p.say(
			{ type: "control_cancel_request", request_id: "r1" },
			{ type: "control_request", request_id: "h1", request: { subtype: "hook_callback" } },
		);
		await tick();
		expect(session.snapshot().items.at(-1)).toMatchObject({ id: "r1", answer: "cancelled" });
		expect(() => session.answerPermission("r1", "allow")).toThrow("no longer waiting");
		expect(p.written.at(-1)).toMatchObject({
			type: "control_response",
			response: { subtype: "error", request_id: "h1" },
		});
	});

	it("interrupts a turn without ending the process", async () => {
		const { session, procs } = makeSession();
		session.send("long job");
		const p = procs[0] as FakeClaude;
		p.say(init());
		await tick();
		session.interrupt();
		await tick();
		expect(p.written.at(-1)).toMatchObject({
			type: "control_request",
			request: { subtype: "interrupt" },
		});
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

	it("starts the Lead in Auto mode ahead of the first message, and keeps it for the next conversation", async () => {
		const { session, procs, events, dir } = makeSession();
		session.setAuto(true);
		expect(procs).toHaveLength(0);
		expect(events).toContainEqual({ type: "auto", auto: true });
		session.send("hi");
		await tick();
		const p = procs[0] as FakeClaude;
		expect(p.written[0]).toMatchObject({
			type: "control_request",
			request: { subtype: "set_permission_mode", mode: "auto" },
		});
		expect(p.written[1]).toMatchObject({ type: "user", message: { content: "hi" } });
		answer(p, "set_permission_mode", { mode: "auto" });
		await tick();
		expect(session.snapshot().items.some((i) => i.kind === "notice")).toBe(false);

		session.reset();
		expect(session.snapshot().auto).toBe(true);
		expect(makeSession(dir).session.snapshot().auto).toBe(true);
	});

	it("switches a running Lead, and back to the user's own default mode", async () => {
		const { session, procs } = makeSession();
		session.send("hi");
		const p = procs[0] as FakeClaude;
		p.say(init());
		await tick();
		session.setAuto(true);
		await tick();
		expect(controls(p).at(-1)).toEqual({ subtype: "set_permission_mode", mode: "auto" });
		answer(p, "set_permission_mode", { mode: "auto" });

		session.setAuto(false);
		await tick();
		expect(controls(p).at(-1)).toEqual({ subtype: "get_settings" });
		answer(p, "get_settings", { effective: { permissions: { defaultMode: "acceptEdits" } } });
		await tick();
		expect(controls(p).at(-1)).toEqual({ subtype: "set_permission_mode", mode: "acceptEdits" });

		// No default in the user's settings means Claude's own.
		session.setAuto(true);
		session.setAuto(false);
		await tick();
		answer(p, "get_settings", { effective: {} });
		await tick();
		expect(controls(p).at(-1)).toEqual({ subtype: "set_permission_mode", mode: "default" });
		expect(p.killed).toBe(false);
	});

	it("leaves Auto on when it is turned back on before the user's default is read", async () => {
		const { session, procs } = makeSession();
		session.setAuto(true);
		session.send("hi");
		const p = procs[0] as FakeClaude;
		session.setAuto(false);
		session.setAuto(true);
		await tick();
		answer(p, "get_settings", { effective: { permissions: { defaultMode: "default" } } });
		await tick();
		const modes = controls(p).filter((c) => c.subtype === "set_permission_mode");
		expect(modes.map((c) => c.mode)).toEqual(["auto", "auto"]);
	});

	it("turns Auto back off and says why when Claude can't run in auto mode", async () => {
		const { session, procs, events } = makeSession();
		session.setAuto(true);
		session.send("hi");
		const p = procs[0] as FakeClaude;
		await tick();
		answer(p, "set_permission_mode", null, "Auto mode is not available for this model");
		await tick();
		expect(session.snapshot().auto).toBe(false);
		expect(events.at(-2)).toEqual({ type: "auto", auto: false });
		expect(session.snapshot().items.at(-1)).toMatchObject({
			kind: "notice",
			tone: "error",
			text: "Auto mode isn't available: Auto mode is not available for this model",
		});
	});

	it("stops the Lead rather than leave it in auto mode with Auto off", async () => {
		const { session, procs } = makeSession();
		session.setAuto(true);
		session.send("long job");
		const p = procs[0] as FakeClaude;
		await tick();
		answer(p, "set_permission_mode", { mode: "auto" });
		session.setAuto(false);
		await tick();
		answer(p, "get_settings", { effective: {} });
		await tick();
		answer(p, "set_permission_mode", null, "internal_error");
		await tick();
		expect(p.killed).toBe(true);
		expect(session.snapshot()).toMatchObject({ busy: false, auto: false });
		expect(session.snapshot().items.at(-1)).toMatchObject({ kind: "notice", tone: "error" });
		session.send("go on");
		expect((procs[1] as FakeClaude).written.some((w) => w.type === "control_request")).toBe(false);
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
