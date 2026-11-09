// During a voice call (Lead.setCall), the Lead's messages and answers to tasks
// wait as permission cards for the user's tap: a call's words are transcribed,
// and may have been misheard or said to someone else in the room. Wired through
// startLead against a fake claude, with the tools called over the Lead's MCP
// server as Claude calls them.
import { describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CH, type LeadItem } from "@ateam/protocol";
import { startLead } from "./index";
import { chatPreferences } from "./settings";

const TASK = {
	id: "t1",
	projectId: "p1",
	name: "fix login",
	branch: "fix-login",
	column: "review",
	agentId: "claude",
	agentStatus: "idle",
	agentIds: ["claude"],
	description: null,
	waitingReason: null,
	question: {
		id: "q1",
		text: "Push to main?",
		options: ["Yes", "No"],
		askedAt: 1,
		allowText: true,
	},
};

function fakeRouter() {
	const calls: { method: string; args: unknown[] }[] = [];
	const handle = async (method: string, args: unknown[]) => {
		calls.push({ method, args });
		if (method === CH.projectsList)
			return [{ id: "p1", name: "web", repoPath: "/r/web", githubOwner: "o", githubName: "web" }];
		if (method === CH.tasksList) return [TASK];
		if (method === CH.tasksGet) return TASK;
		if (method === CH.peersSendFromLead) return { ok: true, reason: "sent" };
		if (method === CH.tasksAnswerQuestion) return null;
		throw new Error(`unexpected ${method}`);
	};
	return { calls, handle };
}

class FakeClaude extends EventEmitter {
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	kill() {
		return true;
	}
}

async function setup(home?: string) {
	const dir = mkdtempSync(join(tmpdir(), "lead-call-"));
	const router = fakeRouter();
	const preferences = chatPreferences(dir, join(dir, "settings.json"), async () => true);
	const lead = await startLead({
		place: "mac",
		home,
		preferences,
		dir,
		handle: router.handle,
		machineOf: () => null,
		deliver: async (_o, paths) => ({ paths }),
		emit: () => {},
		spawnClaude: () => new FakeClaude() as unknown as ChildProcess,
	});
	// Writes mcp.json (the agent starts on the first message).
	lead.send("hello");
	const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).mcpServers.ateam_lead;
	const tool = async (name: string, args: Record<string, unknown>) => {
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
				params: { name, arguments: args },
			}),
		});
		return res.text();
	};
	const cards = () =>
		lead
			.snapshot()
			.items.filter((i): i is Extract<LeadItem, { kind: "permission" }> => i.kind === "permission");
	const did = (method: string) => router.calls.filter((c) => c.method === method).length;
	return { lead, tool, cards, did, preferences };
}

describe("a voice call holds the Lead's messages and answers for a tap", () => {
	it("sends at once with no call on", async () => {
		const { lead, tool, cards, did } = await setup();
		try {
			await tool("send_message", { task: "t1", message: "use the short tone" });
			expect(did(CH.peersSendFromLead)).toBe(1);
			expect(cards()).toEqual([]);
		} finally {
			lead.dispose();
		}
	});

	it("on a call, a message waits as a card and goes only when allowed", async () => {
		const { lead, tool, cards, did } = await setup();
		try {
			lead.setCall(true);
			const told = await tool("send_message", { task: "t1", message: "use the short tone" });
			expect(told).toContain("Held for the user's OK");
			expect(did(CH.peersSendFromLead)).toBe(0);
			const card = cards()[0];
			expect(card?.text).toBe('**Send this to "fix login"?**\n\n> use the short tone');
			expect(card?.canAlways).toBe(false);
			await lead.permission(card?.id ?? "", "allow");
			expect(did(CH.peersSendFromLead)).toBe(1);
			expect(cards()[0]?.answer).toBe("allow");
			// Answered once: a second tap goes to Claude's prompts, which have none.
			expect(() => lead.permission(card?.id ?? "", "allow")).toThrow();
		} finally {
			lead.dispose();
		}
	});

	it("on a call, a denied answer to a task's question never reaches it", async () => {
		const { lead, tool, cards, did } = await setup();
		try {
			lead.setCall(true);
			await tool("answer_question", { task: "t1", answer: "Yes" });
			const card = cards()[0];
			expect(card?.text).toBe('**Answer "fix login"?**\n\n> Push to main?\n\nAnswer: **Yes**');
			await lead.permission(card?.id ?? "", "deny");
			expect(did(CH.tasksAnswerQuestion)).toBe(0);
			expect(cards()[0]?.answer).toBe("deny");
		} finally {
			lead.dispose();
		}
	});

	it("after hanging up, messages go at once again", async () => {
		const { lead, tool, cards, did } = await setup();
		try {
			lead.setCall(true);
			lead.setCall(false);
			await tool("send_message", { task: "t1", message: "go" });
			expect(did(CH.peersSendFromLead)).toBe(1);
			expect(cards()).toEqual([]);
		} finally {
			lead.dispose();
		}
	});
});

for (const agent of ["codex", "opencode"] as const) {
	it(`${agent} Auto cannot bypass the cross-project message card`, async () => {
		const { lead, tool, cards, did, preferences } = await setup("p2");
		try {
			lead.reset();
			await preferences.update({ agent, auto: true });
			await tool("message_other_project", { task: "t1", message: "Please review this" });
			expect(did(CH.peersSendFromLead)).toBe(0);
			expect(cards()).toHaveLength(1);
			await lead.permission(cards()[0]!.id, "deny");
			expect(did(CH.peersSendFromLead)).toBe(0);
			await tool("message_other_project", { task: "t1", message: "Approved request" });
			await lead.permission(cards()[1]!.id, "allow");
			expect(did(CH.peersSendFromLead)).toBe(1);
		} finally {
			lead.dispose();
		}
	});
}
