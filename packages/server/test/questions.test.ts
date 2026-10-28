import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { AteamDb, Task } from "@ateam/db";
import { bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import { formatForRecipient, type OutsideSender, type SendResult } from "../src/peer-messages";
import { answerQuestion, applyAskUser, columnWithQuestion, validateAsk } from "../src/questions";

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
		expect(columnWithQuestion(t, "review")).toBe("needs_attention");
		expect(columnWithQuestion(t, "running")).toBe("running");
	});

	it("delivers the answer as a message from the user, then clears the question", () => {
		applyAskUser(db, { taskId: task.id, text: "Deploy?", options: ["Deploy", "Wait"] }, notify);
		const id = pending()?.id as string;
		answerQuestion(db, send, { taskId: task.id, questionId: id, answer: "Wait" }, notify);
		expect(sent).toEqual([
			{ sender: "user", to: task.id, body: "You asked: Deploy?\n\nThe user's answer: Wait" },
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
});

describe("the answer's framing", () => {
	it("says it comes from the user", () => {
		const text = formatForRecipient([{ body: "The user's answer: Wait", from: "user" }]);
		expect(text).toContain("This comes from the user.");
		expect(text).not.toContain("not from the user");
	});
});
