import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CH, type TaskDTO } from "@ateam/protocol";
import type { LeadItem } from "../../shared/lead";
import { Follower, MAX_FOLLOWED } from "./follow";

const task = (over: Partial<TaskDTO> = {}): TaskDTO =>
	({
		id: "t1",
		name: "fix login",
		agentId: "claude",
		agentStatus: "running",
		question: null,
		lastReplyAt: 100,
		...over,
	}) as TaskDTO;

function make(dir = mkdtempSync(join(tmpdir(), "follow-"))) {
	const items: LeadItem[] = [];
	const reads: string[] = [];
	const follower = new Follower({
		dir,
		record: (i) => items.push(i),
		handle: async (method, args) => {
			reads.push(`${method} ${args[0]}`);
			return method === CH.tasksLastReply ? { text: "Done, tests pass.", at: 200 } : null;
		},
	});
	return { follower, items, reads, dir };
}

describe("Follower", () => {
	it("shows a followed task's new reply once, and skips the one it had when followed", async () => {
		const { follower, items, reads } = make();
		follower.follow(task());
		await follower.onTaskUpdated(task({ lastReplyAt: 100 }));
		expect(items).toHaveLength(0);
		// Two updates for the same finished turn arrive back to back.
		await Promise.all([
			follower.onTaskUpdated(task({ lastReplyAt: 200, agentStatus: "idle" })),
			follower.onTaskUpdated(task({ lastReplyAt: 200, agentStatus: "idle" })),
		]);
		expect(reads).toEqual([`${CH.tasksLastReply} t1`]);
		expect(items).toMatchObject([
			{ kind: "agent", text: "Done, tests pass.", task: { taskId: "t1", name: "fix login" } },
		]);
	});

	it("skips the reply of a turn that ended by asking: the question card says it", async () => {
		const { follower, items, reads } = make();
		follower.follow(task());
		const question = { id: "q", text: "Ship?", options: [], allowText: true, askedAt: 150 };
		await follower.onTaskUpdated(task({ lastReplyAt: 200, question }));
		expect(items).toHaveLength(0);
		expect(reads).toHaveLength(0);
	});

	it("ignores tasks nobody touched from the chat", async () => {
		const { follower, items, reads } = make();
		await follower.onTaskUpdated(task({ id: "other", lastReplyAt: 999 }));
		expect(items).toHaveLength(0);
		expect(reads).toHaveLength(0);
	});

	it("says once when a followed task stops at a prompt in its terminal", async () => {
		const { follower, items } = make();
		follower.follow(task());
		await follower.onTaskUpdated(task({ agentStatus: "awaiting_input" }));
		await follower.onTaskUpdated(task({ agentStatus: "awaiting_input" }));
		expect(items).toMatchObject([{ kind: "notice", task: { taskId: "t1" } }]);
	});

	it("remembers what it follows across restarts, and drops the oldest past the cap", async () => {
		const first = make();
		for (let i = 0; i <= MAX_FOLLOWED; i++) first.follower.follow(task({ id: `t${i}` }));
		const again = make(first.dir);
		await again.follower.onTaskUpdated(task({ id: "t0", lastReplyAt: 500 }));
		await again.follower.onTaskUpdated(task({ id: `t${MAX_FOLLOWED}`, lastReplyAt: 500 }));
		expect(again.items.map((i) => (i.kind === "agent" ? i.task.taskId : ""))).toEqual([
			`t${MAX_FOLLOWED}`,
		]);
	});
});
