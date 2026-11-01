import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { AteamDb, Task } from "@ateam/db";
import { bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import {
	applyPropose,
	clearProposal,
	MAX_PENDING,
	type ProposeRequest,
	validateProposal,
} from "../src/proposals";

let db: AteamDb;
let task: Task;
let notified: string[];
const notify = (id: string) => notified.push(id);

beforeEach(() => {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	bootstrap(sqlite);
	db = drizzle(sqlite, { schema }) as unknown as AteamDb;
	const project = repo.upsertProject(db, { repoPath: "/tmp/repo", name: "Repo" });
	if (!project) throw new Error("seed");
	task = repo.createTask(db, {
		projectId: project.id,
		name: "auth",
		slug: "auth",
		branch: "auth",
		baseBranch: "main",
		worktreePath: "/tmp/auth",
	});
	repo.updateTask(db, task.id, { column: "running", agentStatus: "running" });
	notified = [];
});

const row = () => repo.getTask(db, task.id);
const propose = (req: Omit<ProposeRequest, "taskId">) =>
	applyPropose(db, { taskId: task.id, ...req }, notify, 1000);

describe("validateProposal", () => {
	it("keeps what a task needs and leaves out what it was not given", () => {
		expect(
			validateProposal({ kind: "task", name: " Fix flake ", prompt: " Find it ", yolo: "yes" }),
		).toEqual({ ok: true, proposal: { kind: "task", name: "Fix flake", prompt: "Find it" } });
	});

	it("refuses a missing name or prompt, an unknown agent, and an overlong name", () => {
		expect(validateProposal({ kind: "task", prompt: "x" }).ok).toBe(false);
		expect(validateProposal({ kind: "task", name: "x" }).ok).toBe(false);
		expect(validateProposal({ kind: "task", name: "x", prompt: "y", agent: "gpt" }).ok).toBe(false);
		expect(validateProposal({ kind: "task", name: "x".repeat(61), prompt: "y" }).ok).toBe(false);
	});

	it("needs exactly one schedule on a loop", () => {
		const base = { kind: "loop" as const, name: "Deps", prompt: "Check deps" };
		expect(validateProposal(base).ok).toBe(false);
		expect(validateProposal({ ...base, everyMinutes: 60, dailyAt: "09:00" }).ok).toBe(false);
		expect(validateProposal({ ...base, everyMinutes: 0 }).ok).toBe(false);
		expect(validateProposal({ ...base, everyMinutes: 1.5 }).ok).toBe(false);
		expect(validateProposal({ ...base, dailyAt: "25:00" }).ok).toBe(false);
		expect(validateProposal({ ...base, dailyAt: "9:05" })).toEqual({
			ok: true,
			proposal: { ...base, dailyAt: "09:05" },
		});
		expect(validateProposal({ ...base, everyMinutes: 30, followUp: "/check" })).toEqual({
			ok: true,
			proposal: { ...base, everyMinutes: 30, followUp: "/check" },
		});
	});
});

describe("applyPropose", () => {
	it("files it on the task, holds the card in Needs You and marks it unread", () => {
		const res = propose({
			kind: "task",
			name: "Fix flake",
			prompt: "Find it",
			reason: "Out of scope here",
		});
		expect(res.ok).toBe(true);
		expect(row()?.proposals).toEqual([
			{
				id: expect.any(String),
				proposedAt: 1000,
				kind: "task",
				name: "Fix flake",
				prompt: "Find it",
				reason: "Out of scope here",
			},
		]);
		expect(row()?.column).toBe("needs_attention");
		expect(row()?.isUnread).toBe(true);
		expect(notified).toEqual([task.id]);
		// The agent's next Working event doesn't take the card out of Needs You.
		repo.updateTask(db, task.id, { column: "running" });
		expect(row()?.column).toBe("needs_attention");
	});

	it("queues several, and the same name again replaces that one at the back", () => {
		propose({ kind: "task", name: "A", prompt: "a" });
		propose({ kind: "loop", name: "A", prompt: "loop a", everyMinutes: 60 });
		propose({ kind: "task", name: "B", prompt: "b" });
		propose({ kind: "task", name: "A", prompt: "a, revised" });
		expect(row()?.proposals?.map((p) => `${p.kind}:${p.name}:${p.prompt}`)).toEqual([
			"loop:A:loop a",
			"task:B:b",
			"task:A:a, revised",
		]);
	});

	it(`refuses more than ${MAX_PENDING} waiting at once, and a bad one without filing it`, () => {
		for (let i = 0; i < MAX_PENDING; i++) propose({ kind: "task", name: `T${i}`, prompt: "x" });
		expect(propose({ kind: "task", name: "one more", prompt: "x" }).ok).toBe(false);
		expect(row()?.proposals).toHaveLength(MAX_PENDING);
		expect(propose({ kind: "loop", name: "T0", prompt: "x" }).ok).toBe(false);
		expect(row()?.proposals).toHaveLength(MAX_PENDING);
	});
});

describe("clearProposal", () => {
	it("lets the card leave Needs You only with the last one, to where its agent is", () => {
		propose({ kind: "task", name: "A", prompt: "a" });
		propose({ kind: "task", name: "B", prompt: "b" });
		const [a, b] = row()?.proposals ?? [];
		clearProposal(db, { taskId: task.id, proposalId: a!.id }, notify);
		expect(row()?.proposals?.map((p) => p.name)).toEqual(["B"]);
		expect(row()?.column).toBe("needs_attention");
		clearProposal(db, { taskId: task.id, proposalId: b!.id }, notify);
		expect(row()?.proposals).toEqual([]);
		expect(row()?.column).toBe("running");
		expect(row()?.isUnread).toBe(false);
	});

	it("goes to Review when the agent has stopped, and stays put with a question still open", () => {
		propose({ kind: "task", name: "A", prompt: "a" });
		repo.updateTask(db, task.id, { agentStatus: "idle" });
		clearProposal(db, { taskId: task.id, proposalId: row()!.proposals![0]!.id }, notify);
		expect(row()?.column).toBe("review");

		propose({ kind: "task", name: "B", prompt: "b" });
		repo.updateTask(db, task.id, {
			question: { id: "q", askedAt: 1, text: "Deploy?", options: [], allowText: true },
		});
		clearProposal(db, { taskId: task.id, proposalId: row()!.proposals![0]!.id }, notify);
		expect(row()?.column).toBe("needs_attention");
	});

	it("ignores one already cleared, and never moves a card out of Done", () => {
		propose({ kind: "task", name: "A", prompt: "a" });
		const id = row()!.proposals![0]!.id;
		repo.updateTask(db, task.id, { column: "merged" });
		clearProposal(db, { taskId: task.id, proposalId: id }, notify);
		expect(row()?.column).toBe("merged");
		notified = [];
		clearProposal(db, { taskId: task.id, proposalId: id }, notify);
		expect(notified).toEqual([]);
	});
});
