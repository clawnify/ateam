import { expect, test } from "bun:test";
import type { LeadItem } from "@ateam/protocol";
import {
	announcement,
	contextFrom,
	heldReason,
	piecesOf,
	shouldHold,
	speakable,
	turnsFrom,
	waitingOnUser,
} from "./lead-call";

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
	expect(announcement(perm)).toBe("I need your OK in the chat for this: Run rm -rf build");
	expect(announcement({ ...perm, answer: "allow" })).toBeNull();
	expect(announcement({ kind: "assistant", id: "x", text: "hi", at: 1 })).toBeNull();
	expect(
		announcement({ kind: "notice", id: "n", text: "Restarted.", tone: "info", at: 1 }),
	).toBeNull();
});

test("piecesOf splits what was heard at pauses, so side talk isn't glued to a request", () => {
	const frags = [
		{ text: " Do you want", start: 0, end: 200 },
		{ text: " pizza tonight?", start: 200, end: 600 },
		{ text: " Okay, start a task", start: 2000, end: 2400 },
		{ text: " for disk usage.", start: 2500, end: 2900 },
	];
	expect(piecesOf(frags)).toEqual([
		"Do you want pizza tonight?",
		"Okay, start a task for disk usage.",
	]);
	// A "?" that arrives late, timed with the next words, stays with its question.
	expect(
		piecesOf([
			{ text: " pizza tonight", start: 0, end: 600 },
			{ text: "?", start: 1900, end: 2000 },
			{ text: " Okay, start a task", start: 2000, end: 2400 },
		]),
	).toEqual(["pizza tonight?", "Okay, start a task"]);
	expect(piecesOf([])).toEqual([]);
	expect(piecesOf([{ text: "   ", start: 0, end: 10 }])).toEqual([]);
});

test("shouldHold: quiet holds at 30 s, a false wake at 10 s, endless side talk at 90 s", () => {
	const at = (s: number) => s * 1000;
	const base = { engagedAt: 0, falseWake: false };
	// Quiet room, nothing for the Lead for 31 s.
	expect(shouldHold({ ...base, now: at(31), heardAt: at(20) })).toBe(true);
	expect(shouldHold({ ...base, now: at(29), heardAt: at(20) })).toBe(false);
	// Someone is still talking at 31 s: not yet (it may be a long thought for the Lead).
	expect(shouldHold({ ...base, now: at(31), heardAt: at(30) })).toBe(false);
	// A TV that never stops: on hold 90 s after the last thing for the Lead.
	expect(shouldHold({ ...base, now: at(91), heardAt: at(91) })).toBe(true);
	// Woken by a sound, nothing for the Lead, 1.5 s quiet: back after 10 s.
	expect(shouldHold({ engagedAt: 0, falseWake: true, now: at(11), heardAt: at(9) })).toBe(true);
	expect(shouldHold({ engagedAt: 0, falseWake: true, now: at(11), heardAt: at(10.5) })).toBe(false);
});

test("contextFrom gives the gate the chat and what was held back, in time order, with ages", () => {
	const now = 100_000;
	const items: LeadItem[] = [
		{ kind: "user", id: "1", text: "Tell the checklist one to be friendly.", at: 66_000 },
		{ kind: "assistant", id: "2", text: "Should I message [it](task:t1)?", at: 75_000 },
		{ kind: "user", id: "3", text: "use the short tone", at: 80_000, to: task },
		{ kind: "agent", id: "4", task, text: "Done.", at: 81_000 },
	];
	const asides = [
		{ text: "Did you give food to the cat?", kind: "someone" as const, at: 96_000 },
		// Too old to say anything about what comes next.
		{ text: "Old news on TV.", kind: "background" as const, at: now - 150_000 },
	];
	expect(contextFrom(items, asides, now)).toBe(
		[
			"user (34 s ago): Tell the checklist one to be friendly.",
			"lead (25 s ago): Should I message it?",
			'heard, not sent to the Lead (4 s ago), said to someone else in the room: "Did you give food to the cat?"',
		].join("\n"),
	);
	expect(heldReason("someone")).toBe("sounded like you were talking to someone else");
});

test("shouldHold while the Lead works: after 15 s when it waits on a tap, else after 60 s", () => {
	const at = (s: number) => s * 1000;
	const base = { engagedAt: 0, falseWake: false, pending: true };
	// The Lead waits on the user's tap (announced): no reason to bill the silence.
	expect(shouldHold({ ...base, waitingOnUser: true, now: at(16), heardAt: at(5) })).toBe(true);
	expect(shouldHold({ ...base, waitingOnUser: true, now: at(14), heardAt: at(5) })).toBe(false);
	// A long turn: hold after a minute; its reply reopens the call.
	expect(shouldHold({ ...base, waitingOnUser: false, now: at(59), heardAt: at(5) })).toBe(false);
	expect(shouldHold({ ...base, waitingOnUser: false, now: at(61), heardAt: at(5) })).toBe(true);
	// Never while someone is talking.
	expect(shouldHold({ ...base, waitingOnUser: true, now: at(61), heardAt: at(60) })).toBe(false);
});

test("waitingOnUser: a permission card nobody answered", () => {
	const card = {
		kind: "permission" as const,
		id: "c",
		text: "Send?",
		canAlways: false,
		always: null,
		at: 1,
	};
	expect(waitingOnUser([card])).toBe(true);
	expect(waitingOnUser([{ ...card, answer: "allow" as const }])).toBe(false);
	expect(waitingOnUser([{ kind: "user", id: "u", text: "hi", at: 1 }])).toBe(false);
});
