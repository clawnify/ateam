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
	it("keeps separate artifacts while maintaining the latest-page binding", () => {
		expect(
			applyShowPage(db, { taskId: task.id, title: "Failing tests", html: "<h1>40</h1>" }, notify)
				.ok,
		).toBe(true);
		const first = repo.getTask(db, task.id) as Task;
		expect(first.page).toMatchObject({ title: "Failing tests" });
		expect(first.page?.fromQuestion).toBeUndefined();
		expect(first.isUnread).toBe(true);
		expect(first.column).toBe(task.column);
		expect(repo.getTaskPageHtml(db, task.id)).toBe("<h1>40</h1>");

		applyShowPage(db, { taskId: task.id, html: "<p>now 3</p>" }, notify);
		const second = repo.getTask(db, task.id) as Task;
		expect(second.page?.id).not.toBe(first.page?.id);
		expect(second.page?.title).toBe("Page");
		expect(repo.getTaskPageHtml(db, task.id)).toBe("<p>now 3</p>");
		expect(repo.listTaskPages(db, task.id)).toHaveLength(2);
		expect(repo.getTaskPage(db, task.id, first.page?.id)?.html).toBe("<h1>40</h1>");
		expect(repo.getTaskPage(db, task.id, second.page?.id)?.html).toBe("<p>now 3</p>");
		expect(repo.listTaskPages(db, task.id).every((p) => !("html" in p))).toBe(true);
	});

	it("revises only an explicit artifact id and keeps its title when omitted", () => {
		applyShowPage(db, { taskId: task.id, title: "Research", html: "first" }, notify, 10);
		const first = repo.getTask(db, task.id)?.page;
		if (!first) throw new Error("page missing");
		applyShowPage(db, { taskId: task.id, title: "Plan", html: "plan" }, notify, 20);
		const result = applyShowPage(
			db,
			{ taskId: task.id, pageId: first.id, html: "revised" },
			notify,
			30,
		);
		expect(result.ok).toBe(true);
		expect(result.reason).toContain(first.id);
		expect(repo.listTaskPages(db, task.id).map((page) => page.title)).toEqual(["Research", "Plan"]);
		expect(repo.getTaskPage(db, task.id, first.id)).toMatchObject({
			title: "Research",
			html: "revised",
			at: 30,
		});
		expect(repo.listTaskPages(db, task.id).find((p) => p.title === "Plan")).toBeDefined();
	});

	it("changes the revision marker even when two edits arrive in the same millisecond", () => {
		applyShowPage(db, { taskId: task.id, html: "first" }, notify, 10);
		const first = repo.getTask(db, task.id)?.page;
		if (!first) throw new Error("page missing");
		applyShowPage(db, { taskId: task.id, pageId: first.id, html: "second" }, notify, 10);
		expect(repo.getTaskPage(db, task.id, first.id)).toMatchObject({ html: "second", at: 11 });
	});

	it("cannot read or revise an artifact through another task, or create one from a stale id", () => {
		applyShowPage(db, { taskId: task.id, html: "secret" }, notify);
		const first = repo.getTask(db, task.id)?.page;
		if (!first) throw new Error("page missing");
		const other = repo.createTask(db, {
			projectId: task.projectId,
			name: "other",
			slug: "other",
			branch: "other",
			baseBranch: "main",
			worktreePath: "/tmp/other",
		});
		expect(repo.getTaskPage(db, other.id, first.id)).toBeNull();
		for (const pageId of [first.id, "missing", "", 123]) {
			expect(applyShowPage(db, { taskId: other.id, pageId, html: "changed" }, notify).ok).toBe(
				false,
			);
		}
		expect(repo.listTaskPages(db, other.id)).toEqual([]);
		expect(repo.getTaskPage(db, task.id, first.id)?.html).toBe("secret");
	});

	it("preserves the pre-upgrade page on the first new save", () => {
		const legacy = { id: "legacy", title: "Old research", at: 1 };
		repo.updateTask(db, task.id, { page: legacy });
		db.insert(schema.taskPages).values({ taskId: task.id, html: "old content" }).run();
		expect(repo.listTaskPages(db, task.id)).toEqual([legacy]);
		expect(repo.getTaskPage(db, task.id, legacy.id)?.html).toBe("old content");
		applyShowPage(db, { taskId: task.id, html: "new content" }, notify);
		expect(repo.listTaskPages(db, task.id)).toHaveLength(2);
		expect(repo.getTaskPage(db, task.id, legacy.id)?.html).toBe("old content");
	});

	it("refuses an empty or oversized page, and the page goes with its task", () => {
		expect(validatePage({ html: "  " }, "x").ok).toBe(false);
		const big = validatePage({ html: "é".repeat(MAX_PAGE_BYTES / 2 + 1) }, "x");
		expect(big.ok).toBe(false);
		expect(big.ok || big.reason).toContain("KB");
		applyShowPage(db, { taskId: task.id, html: "<p>x</p>" }, notify);
		repo.deleteTask(db, task.id);
		expect(repo.getTaskPageHtml(db, task.id)).toBeUndefined();
		expect(repo.listTaskPages(db, task.id)).toEqual([]);
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
		expect(t.page?.fromQuestion).toBe(true);
		applyShowPage(db, { taskId: task.id, html: "later" }, notify);
		expect(repo.getTaskPage(db, task.id, t.question?.pageId)?.html).toBe("<table></table>");
		expect(
			applyShowPage(db, { taskId: task.id, pageId: t.question?.pageId, html: "changed" }, notify)
				.ok,
		).toBe(false);
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
