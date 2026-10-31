import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { AteamDb, Task } from "@ateam/db";
import { bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import { formatForRecipient, type OutsideSender, type SendResult } from "../src/peer-messages";
import { answerQuestion, applyAskUser, validateAsk } from "../src/questions";

let db: AteamDb;
let task: Task;
let sent: { sender: OutsideSender; to: string; body: string }[];
let sendResult: SendResult;
const notified: string[] = [];
const notify = (id: string) => notified.push(id);
const send = (sender: OutsideSender, req: { to: string; body: string }) => {
	sent.push({ sender, ...req });
	return sendResult;
};

beforeEach(() => {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	bootstrap(sqlite);
	db = drizzle(sqlite, { schema }) as unknown as AteamDb;
	const project = repo.upsertProject(db, { repoPath: "/tmp/repo", name: "Repo" });
	if (!project) throw new Error("seed");
	task = repo.createTask(db, {
		projectId: project.id,
		name: "deploy",
		slug: "deploy",
		branch: "deploy",
		baseBranch: "main",
		worktreePath: "/tmp/deploy",
	});
	sent = [];
	sendResult = { ok: true, reason: "sent" };
});

const pending = () => repo.getTask(db, task.id)?.question;

describe("validateAsk", () => {
	it("trims, dedupes and caps the options, and always allows text without options", () => {
		const v = validateAsk({
			text: " Ship it? ",
			options: ["Yes", " Yes", "No", ""],
			allowText: false,
		});
		expect(v).toEqual({
			ok: true,
			question: { text: "Ship it?", options: ["Yes", "No"], allowText: false },
		});
		expect(validateAsk({ text: "Why?", allowText: false })).toMatchObject({
			ok: true,
			question: { allowText: true },
		});
		expect(validateAsk({ text: "x", options: ["a", "b", "c", "d", "e"] }).ok).toBe(false);
		expect(validateAsk({ text: "  " }).ok).toBe(false);
	});
});

describe("asking and answering", () => {
	it("files the question in Needs You, and keeps it there when the agent's turn ends", () => {
		const res = applyAskUser(
			db,
			{ taskId: task.id, text: "Deploy?", options: ["Deploy", "Wait"] },
			notify,
		);
		expect(res.ok).toBe(true);
		const t = repo.getTask(db, task.id) as Task;
		expect(t.column).toBe("needs_attention");
		expect(t.isUnread).toBe(true);
		expect(t.question).toMatchObject({
			text: "Deploy?",
			options: ["Deploy", "Wait"],
			allowText: true,
		});
		// The agent's Stop, another agent's message waking it, its exit: none
		// moves the card while the question is open.
		for (const column of ["review", "running", "todo"] as const) {
			expect(repo.updateTask(db, task.id, { column })?.column).toBe("needs_attention");
		}
	});

	it("delivers the answer as a message from the user, then clears the question", () => {
		applyAskUser(db, { taskId: task.id, text: "Deploy?", options: ["Deploy", "Wait"] }, notify);
		const id = pending()?.id as string;
		answerQuestion(db, send, { taskId: task.id, questionId: id, answer: "Wait" }, notify);
		expect(sent).toEqual([
			{
				sender: "user",
				to: task.id,
				body: 'Answer to your ask_user question "Deploy?"\n\nThe user\'s answer: Wait',
			},
		]);
		expect(pending()).toBeNull();
		expect(repo.getTask(db, task.id)?.column).toBe("running");
	});

	it("refuses a stale answer, an off-menu answer, and keeps the question when delivery fails", () => {
		applyAskUser(
			db,
			{ taskId: task.id, text: "Deploy?", options: ["Deploy", "Wait"], allowText: false },
			notify,
		);
		const id = pending()?.id as string;
		expect(() =>
			answerQuestion(db, send, { taskId: task.id, questionId: "old", answer: "Wait" }, notify),
		).toThrow("already answered");
		expect(() =>
			answerQuestion(db, send, { taskId: task.id, questionId: id, answer: "Maybe" }, notify),
		).toThrow("Pick one of");
		sendResult = { ok: false, reason: "rate limit" };
		expect(() =>
			answerQuestion(db, send, { taskId: task.id, questionId: id, answer: "Wait" }, notify),
		).toThrow("rate limit");
		expect(pending()?.id).toBe(id);
	});

	it("dismisses without telling the agent", () => {
		applyAskUser(db, { taskId: task.id, text: "Deploy?" }, notify);
		answerQuestion(
			db,
			send,
			{ taskId: task.id, questionId: pending()?.id as string, answer: null },
			notify,
		);
		expect(sent).toHaveLength(0);
		expect(pending()).toBeNull();
		expect(repo.getTask(db, task.id)?.column).toBe("review");
	});

	it("refuses an answer to a permission prompt no hook holds, but still dismisses it", () => {
		// The card a previous process filed: its hook request died with it.
		for (const kind of ["permission", "askUserQuestion"] as const) {
			repo.updateTask(db, task.id, {
				question: {
					id: kind,
					askedAt: 1,
					text: "Use X?",
					options: ["Allow"],
					allowText: false,
					kind,
				},
				column: "needs_attention",
			});
			expect(() =>
				answerQuestion(db, send, { taskId: task.id, questionId: kind, answer: "Allow" }, notify),
			).toThrow("no longer waiting");
			expect(pending()?.id).toBe(kind);
			answerQuestion(db, send, { taskId: task.id, questionId: kind, answer: null }, notify);
			expect(pending()).toBeNull();
		}
		expect(sent).toHaveLength(0);
	});
});

describe("the answer's framing", () => {
	it("says it comes from the user", () => {
		const text = formatForRecipient([{ body: "The user's answer: Wait", from: "user" }]);
		expect(text).toContain("This comes from the user,");
		expect(text).not.toContain("not from the user");
	});
});

describe("rich options and checklists", () => {
	it("keeps what the agent knows about each option, and its labels for older clients", () => {
		const v = validateAsk({
			text: "Which migration?",
			options: [
				{ label: "In place", description: "Alter the table", cons: ["Locks writes"], risk: "high" },
				{ label: "Shadow table", pros: ["No downtime"], risk: "low", recommended: true },
				"Skip",
			],
		});
		if (!v.ok) throw new Error(v.reason);
		expect(v.question.options).toEqual(["In place", "Shadow table", "Skip"]);
		expect(v.question.choices?.[1]).toEqual({
			label: "Shadow table",
			pros: ["No downtime"],
			risk: "low",
			recommended: true,
		});
		// Plain labels stay plain: no choices to carry.
		const plain = validateAsk({ text: "x", options: ["a", "b"] });
		expect(plain.ok && plain.question).toEqual({ text: "x", options: ["a", "b"], allowText: true });
	});

	it("refuses two recommendations, a bad option, and a long single choice", () => {
		const two = [
			{ label: "a", recommended: true },
			{ label: "b", recommended: true },
		];
		expect(validateAsk({ text: "x", options: two }).ok).toBe(false);
		expect(validateAsk({ text: "x", options: [{ nope: 1 }] }).ok).toBe(false);
		const five = ["a", "b", "c", "d", "e"];
		expect(validateAsk({ text: "x", options: five })).toMatchObject({ ok: false });
		expect(validateAsk({ text: "x", options: five, select: "many" }).ok).toBe(true);
	});

	it("answers a checklist with what was ticked and what was left", () => {
		applyAskUser(
			db,
			{
				taskId: task.id,
				text: "Delete these branches?",
				select: "many",
				options: [{ label: "old-a", checked: true }, { label: "old-b", checked: true }, "keep-c"],
			},
			notify,
		);
		const q = pending();
		expect(q).toMatchObject({ select: "many", allowText: false });
		answerQuestion(
			db,
			send,
			{ taskId: task.id, questionId: q?.id as string, answer: ["old-a"] },
			notify,
		);
		expect(sent[0]?.body).toBe(
			'Answer to your ask_user question "Delete these branches?"\n\nThe user ticked:\n- old-a\n\nThey left unticked:\n- old-b\n- keep-c',
		);
	});

	it("refuses a checklist answer that isn't on the list", () => {
		applyAskUser(
			db,
			{ taskId: task.id, text: "Delete?", select: "many", options: ["a", "b"] },
			notify,
		);
		const id = pending()?.id as string;
		expect(() =>
			answerQuestion(db, send, { taskId: task.id, questionId: id, answer: ["z"] }, notify),
		).toThrow("not on the list");
	});
});

describe("answer framing and size", () => {
	it("quotes only the question's first line, so a long question and a long answer still fit", () => {
		const long = `Which plan?\n\n\`\`\`mermaid\nflowchart LR\n${"  A --> B\n".repeat(300)}\`\`\``;
		applyAskUser(db, { taskId: task.id, text: long.slice(0, 4000) }, notify);
		const answer = "x".repeat(5900);
		answerQuestion(
			db,
			send,
			{ taskId: task.id, questionId: pending()?.id as string, answer },
			notify,
		);
		expect(sent[0]?.body.startsWith('Answer to your ask_user question "Which plan?"')).toBe(true);
		expect(sent[0]?.body.length).toBeLessThan(8000);
	});

	it("sends an answer the Lead passed on as from the Lead, not from the user's own click", () => {
		applyAskUser(db, { taskId: task.id, text: "Deploy?", options: ["Deploy", "Wait"] }, notify);
		const id = pending()?.id as string;
		answerQuestion(
			db,
			send,
			{ taskId: task.id, questionId: id, answer: "Deploy", via: "lead" },
			notify,
		);
		expect(sent[0]?.sender).toBe("lead");
	});
});
