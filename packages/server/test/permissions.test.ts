import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { AteamDb, Task } from "@ateam/db";
import { bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import {
	ALLOW,
	ALLOW_ALWAYS,
	ASK_TOOL,
	DENY,
	describeAsk,
	PermissionBridge,
} from "../src/permissions";

let db: AteamDb;
let task: Task;
let now: number;
let bridge: PermissionBridge;
const SUGGESTION = {
	type: "addRules",
	rules: [{ toolName: "Bash", ruleContent: "npm run lint" }],
	behavior: "allow",
	destination: "localSettings",
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
		name: "lint",
		slug: "lint",
		branch: "lint",
		baseBranch: "main",
		worktreePath: "/tmp/lint",
	});
	repo.createSession(db, {
		taskId: task.id,
		agentId: "claude",
		terminalId: "term",
		cwd: "/tmp/lint",
	});
	now = 1_000_000;
	bridge = new PermissionBridge({ db, notify: () => {}, now: () => now, holdMs: 60_000 });
});

const ask = (suggestions: unknown[] = [SUGGESTION]) =>
	bridge.ask({
		terminalId: "term",
		toolName: "Bash",
		toolInput: { command: "npm run lint" },
		suggestions,
	});
const question = () => repo.getTask(db, task.id)?.question;

describe("PermissionBridge", () => {
	it("files the prompt as the task's question and answers Allow as Claude's decision", async () => {
		const { result } = ask();
		const q = question();
		expect(q).toMatchObject({
			kind: "permission",
			options: [ALLOW, ALLOW_ALWAYS, DENY],
			allowText: false,
		});
		expect(q?.text).toContain("npm run lint");
		expect(repo.getTask(db, task.id)?.column).toBe("needs_attention");
		bridge.answer(q?.id as string, ALLOW);
		expect(await result).toEqual({
			hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
		});
		expect(question()).toBeNull();
		expect(repo.getTask(db, task.id)?.column).toBe("running");
	});

	it("passes Claude's own rule on for Always allow, and a reason for Deny", async () => {
		const first = ask();
		bridge.answer(question()?.id as string, ALLOW_ALWAYS);
		expect(await first.result).toMatchObject({
			hookSpecificOutput: { decision: { behavior: "allow", updatedPermissions: [SUGGESTION] } },
		});
		const second = ask([]);
		expect(question()?.options).toEqual([ALLOW, DENY]);
		bridge.answer(question()?.id as string, DENY);
		expect(await second.result).toMatchObject({
			hookSpecificOutput: { decision: { behavior: "deny" } },
		});
	});

	it("lets the terminal win: moving on releases the hook with no decision and takes the card down", async () => {
		const { result } = ask();
		const id = question()?.id as string;
		// The PreToolUse of the very call that asked lands just before the hook.
		bridge.settle("term", "Working");
		expect(bridge.holds(id)).toBe(true);
		now += 2000;
		bridge.settle("term", "Working");
		expect(await result).toBeNull();
		expect(question()).toBeNull();
		expect(() => bridge.answer(id, ALLOW)).toThrow("no longer waiting");
	});

	it("replaces an older prompt from the same terminal, and leaves an ask_user question alone", async () => {
		const first = ask();
		const second = ask();
		expect(await first.result).toBeNull();
		const q = question();
		repo.updateTask(db, task.id, {
			question: { id: "user-q", text: "?", options: [], allowText: true, askedAt: now },
		});
		now += 2000;
		bridge.settle("term", "Stop");
		expect(await second.result).toBeNull();
		expect(q?.id).not.toBe("user-q");
		expect(question()?.id).toBe("user-q");
	});

	it("describes the common tools in the user's terms", () => {
		expect(describeAsk("Write", { file_path: "src/a.ts" })).toBe("**Write `src/a.ts`?**");
		expect(describeAsk("WebFetch", { url: "https://x.dev" })).toBe("**Fetch https://x.dev?**");
		expect(describeAsk("mcp__gh__merge", { pr: 3 })).toContain("**Use mcp__gh__merge?**");
	});
});

// Claude Code's AskUserQuestion, as it reaches the PermissionRequest hook
// (captured from 2.1.316).
const COLOR = {
	question: "Which color?",
	header: "Color",
	options: [
		{ label: "Blue (Recommended)", description: "The calm one." },
		{ label: "Red", description: "The loud one." },
	],
	multiSelect: false,
};
const TOPPINGS = {
	question: "Which toppings?",
	header: "Toppings",
	options: [{ label: "Ham" }, { label: "Olives" }, { label: "Basil", preview: "~~~ basil ~~~" }],
	multiSelect: true,
};
const askQuestions = (questions: unknown) =>
	bridge.ask({ terminalId: "term", toolName: ASK_TOOL, toolInput: { questions }, suggestions: [] });

describe("PermissionBridge: AskUserQuestion", () => {
	it("shows the question with its options, and answers with Claude's answers field", async () => {
		const { result } = askQuestions([COLOR]);
		const q = question();
		expect(q).toMatchObject({
			kind: "askUserQuestion",
			text: "Which color?",
			options: ["Blue", "Red"],
			allowText: true,
			choices: [
				{ label: "Blue", description: "The calm one.", recommended: true },
				{ label: "Red", description: "The loud one." },
			],
		});
		expect(repo.getTask(db, task.id)?.column).toBe("needs_attention");
		bridge.answer(q?.id as string, "Red");
		expect(await result).toEqual({
			hookSpecificOutput: {
				hookEventName: "PermissionRequest",
				decision: {
					behavior: "allow",
					updatedInput: { questions: [COLOR], answers: { "Which color?": "Red" } },
				},
			},
		});
		expect(question()).toBeNull();
		expect(repo.getTask(db, task.id)?.column).toBe("running");
	});

	it("passes a typed answer through as it was typed", async () => {
		const { result } = askQuestions([COLOR]);
		expect(() => bridge.answer(question()?.id as string, "  ")).toThrow("type an answer");
		bridge.answer(question()?.id as string, " Green, actually ");
		expect(await result).toMatchObject({
			hookSpecificOutput: {
				decision: { updatedInput: { answers: { "Which color?": "Green, actually" } } },
			},
		});
	});

	it("asks one card at a time and hands Claude every answer with the last", async () => {
		const { result } = askQuestions([COLOR, TOPPINGS]);
		const first = question();
		expect(first?.text).toBe("*Color · 1 of 2*\n\nWhich color?");
		bridge.answer(first?.id as string, "Blue");

		const second = question();
		expect(second?.id).not.toBe(first?.id);
		expect(second?.askedAt).toBe(first?.askedAt as number);
		expect(bridge.holds(first?.id as string)).toBe(false);
		expect(second).toMatchObject({
			kind: "askUserQuestion",
			select: "many",
			allowText: false,
			options: ["Ham", "Olives", "Basil"],
		});
		expect(second?.text).toContain("~~~ basil ~~~");
		expect(repo.getTask(db, task.id)?.column).toBe("needs_attention");

		bridge.answer(second?.id as string, ["Ham", "Olives"]);
		expect(await result).toMatchObject({
			hookSpecificOutput: {
				decision: {
					behavior: "allow",
					updatedInput: {
						questions: [COLOR, TOPPINGS],
						answers: { "Which color?": "Blue", "Which toppings?": "Ham, Olives" },
					},
				},
			},
		});
		expect(question()).toBeNull();
	});

	it("lets the hook drop out mid-way: the card for the current question comes down", async () => {
		const { result, cancel } = askQuestions([COLOR, TOPPINGS]);
		bridge.answer(question()?.id as string, "Blue");
		const second = question()?.id as string;
		cancel();
		expect(await result).toBeNull();
		expect(question()).toBeNull();
		expect(() => bridge.answer(second, ["Ham"])).toThrow("no longer waiting");
	});

	it("falls back to a permission prompt when the input isn't the documented shape", () => {
		askQuestions("not a list");
		expect(question()).toMatchObject({ kind: "permission", options: [ALLOW, DENY] });
	});
});
