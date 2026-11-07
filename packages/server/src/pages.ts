/**
 * Pages an agent makes for the user (the show_page board tool, and ask_user's
 * `page`): any HTML it likes, a dashboard, a comparison, a report, drawn by the
 * desktop in a sandboxed frame (apps/desktop/src/main/pages.ts) where its
 * scripts run but cannot reach Ateam, the network beyond loading libraries, or
 * the window around it.
 *
 * Multiple pages per task. The HTML is stored apart from the
 * task (saved_task_pages) and read with tasks:page, so the board's task list, sent
 * to every client on every change, carries only its title.
 */
import { randomUUID } from "node:crypto";
import { type AteamDb, repo, type TaskPage } from "@ateam/db";

/** Room for a self-contained page with its data inlined; libraries load from a CDN. */
export const MAX_PAGE_BYTES = 200_000;
export const MAX_PAGE_TITLE = 80;

export type PageVerdict = { ok: true; title: string; html: string } | { ok: false; reason: string };

export function validatePage(
	raw: { title?: unknown; html?: unknown },
	fallbackTitle: string,
): PageVerdict {
	const html = typeof raw.html === "string" ? raw.html.trim() : "";
	if (!html) return { ok: false, reason: "the page's html is empty" };
	const bytes = Buffer.byteLength(html, "utf8");
	if (bytes > MAX_PAGE_BYTES)
		return {
			ok: false,
			reason: `the page is ${Math.ceil(bytes / 1000)} KB; keep it under ${MAX_PAGE_BYTES / 1000} KB (load libraries from a CDN instead of inlining them, and summarise the data)`,
		};
	const given = typeof raw.title === "string" ? raw.title.trim() : "";
	const title = (given || fallbackTitle).slice(0, MAX_PAGE_TITLE);
	return { ok: true, title, html };
}

/** File the page on its task and return its summary. */
export function savePage(
	db: AteamDb,
	taskId: string,
	title: string,
	html: string,
	now = Date.now(),
	fromQuestion = false,
	pageId?: string,
): TaskPage {
	const page: TaskPage = {
		id: pageId ?? randomUUID(),
		title,
		at: now,
		...(fromQuestion ? { fromQuestion } : {}),
	};
	repo.setTaskPage(db, taskId, page, html);
	return page;
}

/** show_page: the page appears on the task's panel and in the Lead chat. */
export function applyShowPage(
	db: AteamDb,
	req: { taskId: string; title?: unknown; html?: unknown; pageId?: unknown },
	notify: (taskId: string) => void,
	now = Date.now(),
): { ok: boolean; reason: string } {
	const task = repo.getTask(db, req.taskId);
	if (!task) return { ok: false, reason: `no task ${req.taskId}` };
	let previous: ReturnType<typeof repo.getTaskPage> = null;
	if (req.pageId !== undefined) {
		if (typeof req.pageId !== "string" || !req.pageId)
			return { ok: false, reason: "pageId must name an existing artifact on this task" };
		previous = repo.getTaskPage(db, task.id, req.pageId);
		if (!previous || previous.fromQuestion)
			return {
				ok: false,
				reason: "pageId must name an existing artifact on this task, not a question page",
			};
	}
	const verdict = validatePage(req, previous?.title ?? "Page");
	if (!verdict.ok) return verdict;
	const page = savePage(
		db,
		task.id,
		verdict.title,
		verdict.html,
		previous ? Math.max(now, previous.at + 1) : now,
		false,
		previous?.id,
	);
	repo.updateTask(db, task.id, { isUnread: true });
	notify(task.id);
	return {
		ok: true,
		reason: `Shown. Artifact id: ${page.id}. The user sees it on this task's panel in Ateam and in the Lead chat if they follow this task (not on the phone yet). Other artifacts stay saved. To revise this artifact, pass its pageId to show_page. Do not paste the HTML into your reply; say in a line what it shows.`,
	};
}

/** The first line of a question as a page title: markdown marks dropped. */
export function titleFrom(text: string): string {
	const line = text.split("\n").find((l) => l.trim()) ?? "";
	return (
		line
			.replace(/[#*_`>]/g, "")
			.trim()
			.slice(0, MAX_PAGE_TITLE) || "Question"
	);
}
