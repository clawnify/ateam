import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { AteamDb, Task } from "@ateam/db";
import { bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import { applyShowPage, MAX_PAGE_BYTES, titleFrom, validatePage } from "../src/pages";
import { applyAskUser } from "../src/questions";

let db: AteamDb;
let task: Task;
const notify = () => {};

beforeEach(() => {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	bootstrap(sqlite);
	db = drizzle(sqlite, { schema }) as unknown as AteamDb;
	const project = repo.upsertProject(db, { repoPath: "/tmp/repo", name: "Repo" });
	if (!project) throw new Error("seed");
	task = repo.createTask(db, {
		projectId: project.id,
		name: "tests",
		slug: "tests",
		branch: "tests",
		baseBranch: "main",
		worktreePath: "/tmp/tests",
	});
});

describe("show_page", () => {
	it("keeps the HTML off the task row and replaces the last page", () => {
		expect(
			applyShowPage(db, { taskId: task.id, title: "Failing tests", html: "<h1>40</h1>" }, notify)
				.ok,
		).toBe(true);
		const first = repo.getTask(db, task.id) as Task;
		expect(first.page).toMatchObject({ title: "Failing tests" });
		expect(first.isUnread).toBe(true);
		expect(first.column).toBe(task.column);
		expect(repo.getTaskPageHtml(db, task.id)).toBe("<h1>40</h1>");

		applyShowPage(db, { taskId: task.id, html: "<p>now 3</p>" }, notify);
		const second = repo.getTask(db, task.id) as Task;
		expect(second.page?.id).not.toBe(first.page?.id);
		expect(second.page?.title).toBe("Page");
		expect(repo.getTaskPageHtml(db, task.id)).toBe("<p>now 3</p>");
	});

	it("refuses an empty or oversized page, and the page goes with its task", () => {
		expect(validatePage({ html: "  " }, "x").ok).toBe(false);
		const big = validatePage({ html: "é".repeat(MAX_PAGE_BYTES / 2 + 1) }, "x");
		expect(big.ok).toBe(false);
		expect(big.ok || big.reason).toContain("KB");
		applyShowPage(db, { taskId: task.id, html: "<p>x</p>" }, notify);
		repo.deleteTask(db, task.id);
		expect(repo.getTaskPageHtml(db, task.id)).toBeUndefined();
	});
});

describe("ask_user with a page", () => {
	it("files the page and points the question at it", () => {
		const res = applyAskUser(
			db,
			{
				taskId: task.id,
				text: "## Which schema?\nDetails below",
				options: ["A", "B"],
				page: "<table></table>",
			},
			notify,
		);
		expect(res.ok).toBe(true);
		const t = repo.getTask(db, task.id) as Task;
		expect(t.question?.pageId).toBe(t.page?.id);
		expect(t.page?.title).toBe("Which schema?");
	});

	it("files neither when the page is refused", () => {
		const res = applyAskUser(
			db,
			{ taskId: task.id, text: "Which?", options: ["A"], page: "x".repeat(MAX_PAGE_BYTES + 1) },
			notify,
		);
		expect(res.ok).toBe(false);
		const t = repo.getTask(db, task.id) as Task;
		expect(t.question).toBeNull();
		expect(t.page).toBeNull();
	});

	it("titles a page from the question's first line", () => {
		expect(titleFrom("\n**Pick one** of these")).toBe("Pick one of these");
		expect(titleFrom("")).toBe("Question");
	});
});
