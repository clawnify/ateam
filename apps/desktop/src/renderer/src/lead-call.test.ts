import { expect, test } from "bun:test";
import type { LeadItem } from "@ateam/protocol";
import { announcement, speakable, turnsFrom } from "./lead-call";

const task = { taskId: "t1", name: "Disk usage on the box page", agentId: "claude" };

test("speakable keeps the words of links, drops markdown and code", () => {
	expect(speakable("See [the disk task](task:abc123) and **PR 512**.")).toBe(
		"See the disk task and PR 512.",
	);
	expect(speakable("Run:\n```sh\nbun test\n```\nthen `merge`.")).toBe(
		"Run: (code in the chat) then merge.",
	);
	expect(speakable("## Plan\n- one\n- two\n> quoted")).toBe("Plan one two quoted");
});

test("speakable cuts a long reply at a sentence and says where the rest is", () => {
	const long = `${"This sentence is about the board. ".repeat(100)}`;
	const s = speakable(long, 200);
	expect(s.length).toBeLessThan(260);
	expect(s.endsWith("board. The rest is in the chat.")).toBe(true);
});

test("turnsFrom gives the voice the chat: the user's words, the Lead's, task replies", () => {
	const items: LeadItem[] = [
		{ kind: "user", id: "1", text: "What's in flight?", at: 1 },
		{ kind: "tool", id: "2", name: "get_board", input: {}, at: 2 },
		{ kind: "assistant", id: "3", text: "Three tasks: [disk](task:t1) is running.", at: 3 },
		{ kind: "user", id: "4", text: "use the short tone", at: 4, to: task },
		{ kind: "agent", id: "5", task, text: "Done, PR 512 is up.", at: 5 },
	];
	expect(turnsFrom(items)).toEqual([
		{ role: "user", text: "What's in flight?" },
		{ role: "assistant", text: "Three tasks: disk is running." },
		{ role: "user", text: '(to the task "Disk usage on the box page") use the short tone' },
		{
			role: "developer",
			text: 'The task "Disk usage on the box page" replied: Done, PR 512 is up.',
		},
	]);
});

test("announcement speaks up for task news and waiting approvals, not for settled ones", () => {
	expect(announcement({ kind: "agent", id: "a", task, text: "Done.", at: 1 })).toBe(
		'Update: the task "Disk usage on the box page" replied: Done.',
	);
	const perm: LeadItem = {
		kind: "permission",
		id: "p",
		text: "Run `rm -rf build`",
		canAlways: false,
		always: null,
		at: 1,
	};
	expect(announcement(perm)).toBe("The Lead needs your approval in the chat: Run rm -rf build");
	expect(announcement({ ...perm, answer: "allow" })).toBeNull();
	expect(announcement({ kind: "assistant", id: "x", text: "hi", at: 1 })).toBeNull();
	expect(
		announcement({ kind: "notice", id: "n", text: "Restarted.", tone: "info", at: 1 }),
	).toBeNull();
});
