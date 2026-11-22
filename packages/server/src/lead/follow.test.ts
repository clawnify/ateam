import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CH, type LeadItem, type TaskDTO } from "@ateam/protocol";
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
	const notes: string[] = [];
	const follower = new Follower({
		dir,
		record: (i) => items.push(i),
		note: (line) => notes.push(line),
		handle: async (method, args) => {
			reads.push(`${method} ${args[0]}`);
			return method === CH.tasksLastReply ? { text: "Done, tests pass.", at: 200 } : null;
		},
	});
	return { follower, items, reads, notes, dir };
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

	it("draws a followed task's new page once, but not the one it had or a question's", async () => {
		const { follower, items } = make();
		const page = (id: string) => ({ id, title: `page ${id}`, at: 150 });
		follower.follow(task({ page: page("old") }));
		await follower.onTaskUpdated(task({ page: page("old") }));
		expect(items).toHaveLength(0);
		await follower.onTaskUpdated(task({ page: page("new") }));
		await follower.onTaskUpdated(task({ page: page("new") }));
		expect(items).toMatchObject([{ kind: "page", pageId: "new", title: "page new" }]);
		const question = {
			id: "q",
			text: "Which?",
			options: [],
			allowText: true,
			askedAt: 160,
			pageId: "asked",
		};
		await follower.onTaskUpdated(task({ page: page("asked"), question }));
		expect(items).toHaveLength(1);
	});

	it("shows an explicit artifact revision once, including after a restart", async () => {
		const first = make();
		const page = { id: "artifact", title: "Research", at: 150 };
		first.follower.follow(task({ page }));
		await first.follower.onTaskUpdated(task({ page: { ...page, at: 151 } }));
		await first.follower.onTaskUpdated(task({ page: { ...page, at: 151 } }));
		expect(first.items).toMatchObject([{ kind: "page", pageId: "artifact", at: 151 }]);
		const again = make(first.dir);
		await again.follower.onTaskUpdated(task({ page: { ...page, at: 151 } }));
		expect(again.items).toHaveLength(0);
		await again.follower.onTaskUpdated(task({ page: { ...page, at: 152 } }));
		expect(again.items).toMatchObject([{ kind: "page", pageId: "artifact", at: 152 }]);
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

	const quit = {
		state: "failed" as const,
		from: ["lead" as const],
		why: "its agent quit 7 s after Ateam started it, before it reported starting up",
		opening: "please rebase",
		at: 300,
	};

	it("says when the Lead's message never reached a followed task, and tells the Lead", async () => {
		const { follower, items, notes } = make();
		follower.follow(task());
		await follower.onTaskUpdated(task({ undelivered: quit }));
		await follower.onTaskUpdated(task({ undelivered: quit }));
		expect(items).toMatchObject([
			{
				kind: "notice",
				tone: "error",
				text: "The Lead's message to fix login did not reach its agent: its agent quit 7 s after Ateam started it, before it reported starting up.",
				task: { taskId: "t1", name: "fix login" },
			},
		]);
		expect(notes).toEqual([
			'your message to [fix login](task:t1) that begins "please rebase" did not reach its agent: its agent quit 7 s after Ateam started it, before it reported starting up. No answer to it will come; the user saw this in the chat.',
		]);
	});

	it("tells only the user about their own message, and a held one as news, not an error", async () => {
		const { follower, items, notes } = make();
		follower.follow(task());
		await follower.onTaskUpdated(
			task({
				undelivered: {
					state: "stalled",
					from: ["user"],
					why: "Ateam started its agent 2 min ago and it has not started up since, most likely held at a prompt in its terminal (a trust or review dialog, a sign-in)",
					opening: "yes",
					at: 300,
				},
			}),
		);
		expect(items).toMatchObject([
			{
				kind: "notice",
				tone: "info",
				text: "Your message to fix login has not reached its agent yet: Ateam started its agent 2 min ago and it has not started up since, most likely held at a prompt in its terminal (a trust or review dialog, a sign-in). It goes in once that is answered.",
			},
		]);
		expect(notes).toEqual([]);
	});

	it("does not tell one the task already had when followed, but tells a later one", async () => {
		const { follower, items } = make();
		follower.follow(task({ undelivered: quit }));
		await follower.onTaskUpdated(task({ undelivered: quit }));
		expect(items).toHaveLength(0);
		await follower.onTaskUpdated(task({ undelivered: { ...quit, at: 400 } }));
		expect(items).toHaveLength(1);
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
