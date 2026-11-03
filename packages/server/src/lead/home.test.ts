// A project window's own Lead chat (LeadToolDeps.home): its board, proposals,
// messages and answers stay in its project; another project's tasks are read
// freely and messaged only through message_other_project, which Claude asks the
// user about because it is not pre-approved; the main chat hears of it.
import { describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CH, type LeadEvent } from "@ateam/protocol";
import { startLead } from "./index";
import { createLeadTools, LEAD_TOOL_NAMES, OTHER_PROJECT_TOOL } from "./tools";

const PROJECTS = [
	{ id: "p1", name: "web", repoPath: "/r/web", githubOwner: "o", githubName: "web" },
	{ id: "p2", name: "api", repoPath: "/r/api", githubOwner: "o", githubName: "api" },
];
const task = (id: string, projectId: string, name: string) => ({
	id,
	projectId,
	name,
	branch: name,
	column: "review",
	agentId: "claude",
	agentStatus: "idle",
	agentIds: ["claude"],
	description: null,
	waitingReason: null,
	question: { id: "q1", text: "Which one?", options: ["a", "b"], askedAt: 1, allowText: true },
});
const TASKS = [task("t1", "p1", "fix login"), task("t2", "p2", "rename field")];

function fakeRouter() {
	const calls: { method: string; args: unknown[] }[] = [];
	const handle = async (method: string, args: unknown[]) => {
		calls.push({ method, args });
		if (method === CH.projectsList) return PROJECTS;
		if (method === CH.tasksList) return TASKS.filter((t) => t.projectId === args[0]);
		if (method === CH.tasksGet) return TASKS.find((t) => t.id === args[0]);
		if (method === CH.peersSendFromLead) return { ok: true, reason: "sent" };
		if (method === CH.tasksAnswerQuestion) return null;
		throw new Error(`unexpected ${method}`);
	};
	return { calls, handle };
}

const sent = (r: ReturnType<typeof fakeRouter>) =>
	r.calls.filter((c) => c.method === CH.peersSendFromLead).map((c) => c.args[0]);

describe("a project window's own Lead chat", () => {
	it("lists its own project unless it names another, or all", async () => {
		const tools = createLeadTools({
			handle: fakeRouter().handle,
			machineOf: () => null,
			home: "p1",
		});
		const own = (await tools.call("get_board", {}))?.text ?? "";
		expect(own).toContain("fix login");
		expect(own).not.toContain("rename field");
		const other = (await tools.call("get_board", { project: "api" }))?.text ?? "";
		expect(other).toContain("rename field");
		expect(other).not.toContain("fix login");
		const all = (await tools.call("get_board", { project: "all" }))?.text ?? "";
		expect(all).toContain("fix login");
		expect(all).toContain("rename field");
	});

	it("the main chat still lists every project", async () => {
		const tools = createLeadTools({ handle: fakeRouter().handle, machineOf: () => null });
		const text = (await tools.call("get_board", {}))?.text ?? "";
		expect(text).toContain("fix login");
		expect(text).toContain("rename field");
	});

	it("send_message stays in its project and points to message_other_project for the rest", async () => {
		const r = fakeRouter();
		const tools = createLeadTools({ handle: r.handle, machineOf: () => null, home: "p1" });
		expect(
			(await tools.call("send_message", { task: "fix login", message: "rebase" }))?.isError,
		).toBeFalsy();
		const res = await tools.call("send_message", { task: "rename field", message: "rebase" });
		expect(res?.isError).toBe(true);
		expect(res?.text).toContain(OTHER_PROJECT_TOOL);
		expect(sent(r)).toEqual([{ taskId: "t1", body: "rebase" }]);
	});

	it("message_other_project reaches another project's task and tells the main chat", async () => {
		const r = fakeRouter();
		const heard: unknown[] = [];
		const touched: string[] = [];
		const tools = createLeadTools({
			handle: r.handle,
			machineOf: () => null,
			home: "p1",
			onTouch: (t) => touched.push(t.id),
			onElsewhere: (m) =>
				heard.push({ task: m.task.id, from: m.homeName, to: m.projectName, body: m.body }),
		});
		const res = await tools.call(OTHER_PROJECT_TOOL, {
			task: "rename field",
			message: "it's userId now",
		});
		expect(res?.isError).toBeFalsy();
		expect(sent(r)).toEqual([{ taskId: "t2", body: "it's userId now" }]);
		// Its reply comes back to this chat, like any task it messaged.
		expect(touched).toEqual(["t2"]);
		expect(heard).toEqual([{ task: "t2", from: "web", to: "api", body: "it's userId now" }]);
		// Its own project's tasks go through send_message, which needs no approval.
		const own = await tools.call(OTHER_PROJECT_TOOL, { task: "fix login", message: "x" });
		expect(own?.isError).toBe(true);
		expect(own?.text).toContain("send_message");
	});

	it("only a project's own chat has message_other_project, and it is never pre-approved", async () => {
		const names = (t: { tools: readonly unknown[] }) =>
			(t.tools as readonly { name: string }[]).map((x) => x.name);
		const handle = fakeRouter().handle;
		expect(names(createLeadTools({ handle, machineOf: () => null, home: "p1" }))).toContain(
			OTHER_PROJECT_TOOL,
		);
		const main = createLeadTools({ handle, machineOf: () => null });
		expect(names(main)).not.toContain(OTHER_PROJECT_TOOL);
		expect(await main.call(OTHER_PROJECT_TOOL, { task: "t2", message: "x" })).toBeNull();
		expect(LEAD_TOOL_NAMES.some((n) => n.endsWith(`__${OTHER_PROJECT_TOOL}`))).toBe(false);
		expect(LEAD_TOOL_NAMES.some((n) => n.endsWith("__send_message"))).toBe(true);
	});

	it("proposes in its own project, with or without naming it, and nowhere else", async () => {
		const proposed: { projectId: string }[] = [];
		const tools = createLeadTools({
			handle: fakeRouter().handle,
			machineOf: () => null,
			home: "p1",
			propose: (p) => proposed.push(p),
		});
		const bare = await tools.call("propose_task", {
			name: "Fix it",
			prompt: "Fix the login loop.",
		});
		expect(bare?.isError).toBeFalsy();
		expect(
			(await tools.call("propose_task", { project: "web", name: "Again", prompt: "x" }))?.isError,
		).toBeFalsy();
		const other = await tools.call("propose_task", { project: "api", name: "Rename", prompt: "x" });
		expect(other?.isError).toBe(true);
		expect(other?.text).toContain("main window");
		expect(proposed.map((p) => p.projectId)).toEqual(["p1", "p1"]);
	});

	it("answers questions in its own project only", async () => {
		const r = fakeRouter();
		const tools = createLeadTools({ handle: r.handle, machineOf: () => null, home: "p1" });
		expect(
			(await tools.call("answer_question", { task: "fix login", answer: "a" }))?.isError,
		).toBeFalsy();
		expect(
			(await tools.call("answer_question", { task: "rename field", answer: "a" }))?.isError,
		).toBe(true);
		expect(r.calls.filter((c) => c.method === CH.tasksAnswerQuestion)).toHaveLength(1);
	});

	it("reads another project's task", async () => {
		const tools = createLeadTools({
			handle: async (method, args) => {
				if (method === CH.tasksLastReply) return null;
				return fakeRouter().handle(method, args);
			},
			machineOf: () => null,
			home: "p1",
		});
		const res = await tools.call("read_task", { task: "rename field" });
		expect(res?.isError).toBeFalsy();
		expect(res?.text).toContain('"id": "t2"');
	});

	it("names the task on the permission card once the board showed it", async () => {
		const tools = createLeadTools({
			handle: fakeRouter().handle,
			machineOf: () => null,
			home: "p1",
		});
		const tool = `mcp__ateam_lead__${OTHER_PROJECT_TOOL}`;
		expect(tools.describe(tool, { task: "t2", message: "hi" })).toBe(
			`**Message "t2", outside this chat's project?**\n\n> hi`,
		);
		await tools.call("get_board", { project: "all" });
		expect(tools.describe(tool, { task: "t2", message: "line one\nline two" })).toBe(
			`**Message "rename field" in api, outside this chat's project?**\n\n> line one\n> line two`,
		);
		expect(tools.describe("mcp__ateam_lead__send_message", { task: "t1" })).toBeNull();
	});
});

// ---- wired through startLead, against a fake claude --------------------------

class FakeClaude extends EventEmitter {
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	written: Record<string, unknown>[] = [];
	constructor(
		public args: string[],
		public cwd: string,
	) {
		super();
		this.stdin.on("data", (d: Buffer) => {
			for (const line of d.toString().split("\n")) if (line) this.written.push(JSON.parse(line));
		});
	}
	say(...lines: unknown[]) {
		for (const l of lines) this.stdout.write(`${JSON.stringify(l)}\n`);
	}
	kill() {
		return true;
	}
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("startLead for a project window", () => {
	it("works in the shared folder, shows a readable card, and gives the main chat a note", async () => {
		const shared = mkdtempSync(join(tmpdir(), "lead-main-"));
		const dir = join(shared, "projects", "p1");
		const procs: FakeClaude[] = [];
		const events: LeadEvent[] = [];
		const lines: string[] = [];
		const lead = await startLead({
			place: "mac",
			dir,
			cwd: shared,
			home: "p1",
			handle: fakeRouter().handle,
			machineOf: () => null,
			deliver: async (_o, paths) => ({ paths }),
			emit: (e) => events.push(e),
			onElsewhere: (l) => lines.push(l),
			spawnClaude: (args, cwd) => {
				const p = new FakeClaude(args, cwd);
				procs.push(p);
				return p as unknown as ChildProcess;
			},
		});
		try {
			lead.send("tell api's rename task we use userId");
			const p = procs[0] as FakeClaude;
			// "Always allow" rules live in the working folder: shared with the main chat.
			expect(p.cwd).toBe(shared);
			// Its own transcript, state and MCP config.
			const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).mcpServers.ateam_lead;

			p.say(
				{ type: "system", subtype: "init", session_id: "s1" },
				{
					type: "control_request",
					request_id: "r1",
					request: {
						subtype: "can_use_tool",
						tool_name: `mcp__ateam_lead__${OTHER_PROJECT_TOOL}`,
						input: { task: "t2", message: "we use userId" },
					},
				},
			);
			await tick();
			const card = lead.snapshot().items.find((i) => i.kind === "permission");
			expect(card && "text" in card ? card.text : "").toBe(
				`**Message "t2", outside this chat's project?**\n\n> we use userId`,
			);

			// The tool call itself, as Claude makes it once the user allowed it.
			const res = await fetch(mcp.url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					authorization: mcp.headers.Authorization,
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: OTHER_PROJECT_TOOL, arguments: { task: "t2", message: "we use userId" } },
				}),
			});
			expect(res.ok).toBe(true);
			await res.text();
			expect(lines).toEqual([
				'messaged [rename field](task:t2) in api from web\'s own Lead chat: "we use userId"',
			]);
		} finally {
			lead.dispose();
		}
	});

	it("the main chat reads the note with the user's next message", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lead-main-"));
		const procs: FakeClaude[] = [];
		const lead = await startLead({
			place: "mac",
			dir,
			handle: fakeRouter().handle,
			machineOf: () => null,
			deliver: async (_o, paths) => ({ paths }),
			emit: () => {},
			spawnClaude: (args, cwd) => {
				const p = new FakeClaude(args, cwd);
				procs.push(p);
				return p as unknown as ChildProcess;
			},
		});
		try {
			lead.note(
				'messaged [rename field](task:t2) in api from web\'s own Lead chat: "we use userId"',
			);
			lead.send("what's new?");
			await tick();
			const first = (procs[0] as FakeClaude).written.find((w) => w.type === "user") as {
				message: { content: string };
			};
			expect(first.message.content).toContain("from web's own Lead chat");
			expect(first.message.content).toEndWith("what's new?");
		} finally {
			lead.dispose();
		}
	});
});
