// macOS notification when a task's wait comes due (see waits.ts in the server),
// an agent asks a question, or proposes a task or loop. While a project's own
// window is in front, other projects' banners wait until the user leaves it.
//
// The engine already does the board's half: it files the card in Needs You and
// stamps `waitingFiredAt`. This is the half that reaches you when you are not
// looking at the board. It watches the taskUpdated stream every engine pushes
// (the local one and each connected box), so it needs no channel of its own.
//
// Once per firing: the key is (task, waitingFiredAt), and a re-set wait gets a
// new stamp. Only a FRESH firing: the same task keeps arriving with the old
// stamp on every later update (a git refresh, a rename), and after a restart
// this process has forgotten what it already showed, so anything older than a
// few minutes is the card's job, not a notification's.
import type { TaskDTO } from "@ateam/protocol";
import { Notification } from "electron";

/** How late a firing may still be announced: covers boot and clock skew. */
export const FRESH_MS = 10 * 60_000;

export interface WaitNotice {
	key: string;
	title: string;
	body: string;
}

/** The notice to show for this update, or null. Pure; `shown` is read, not written. */
export function waitNotice(
	task: TaskDTO,
	shown: ReadonlySet<string>,
	now: number,
): WaitNotice | null {
	const firedAt = task.waitingFiredAt;
	if (firedAt == null) return null;
	if (now - firedAt > FRESH_MS) return null;
	const key = `${task.id}:${firedAt}`;
	if (shown.has(key)) return null;
	return {
		key,
		title: task.name,
		body: task.waitingReason ? `Check on ${task.waitingReason}` : "A wait on this task is due",
	};
}

/**
 * A question a task's agent just asked (ask_user; see questions.ts in the
 * server), or Claude Code asking through its hook (permissions.ts). Same rules
 * as a wait: once per question, and only while fresh. "Once" is per askedAt,
 * not per id: the cards of one AskUserQuestion call share it, so answering the
 * first card doesn't pop a banner for the next one.
 */
export function questionNotice(
	task: TaskDTO,
	shown: ReadonlySet<string>,
	now: number,
): WaitNotice | null {
	const q = task.question;
	if (!q || now - q.askedAt > FRESH_MS) return null;
	const key = `${task.id}:q:${q.askedAt}`;
	if (shown.has(key)) return null;
	// An AskUserQuestion card's option previews follow its question, each a bold
	// label over a fenced mockup (askCard in permissions.ts). A banner can't draw
	// them, so it stops before the first.
	const text = q.kind === "askUserQuestion" ? (q.text.split(PREVIEW)[0] ?? "") : q.text;
	return { key, title: task.name, body: plainText(text) };
}

const PREVIEW = /\n\n\*\*[^\n]*\*\*\n\n```/;

/**
 * A task or loop a task's agent just proposed (proposals.ts in the server),
 * which holds the card in Needs You like a question. Once per proposal and
 * only while fresh; the newest is at the back. A click opens the task, and
 * its panel then opens the proposal's dialog.
 */
export function proposalNotice(
	task: TaskDTO,
	shown: ReadonlySet<string>,
	now: number,
): WaitNotice | null {
	const p = task.proposals?.at(-1);
	if (!p || now - p.proposedAt > FRESH_MS) return null;
	const key = `${task.id}:p:${p.id}`;
	if (shown.has(key)) return null;
	const what = p.kind === "loop" ? "Proposes a loop" : "Proposes a task";
	return {
		key,
		title: task.name,
		body: [`${what}: ${p.name}`, p.reason].filter(Boolean).join("\n"),
	};
}

/**
 * A question's markdown as the plain text a notification shows. Fence lines,
 * heading marks, `*` emphasis, code ticks and link syntax go; what is inside
 * code (a permission prompt's command, a path) stays as written. Underscores
 * stay too: in a path or a tool name they are not emphasis.
 */
export function plainText(md: string): string {
	let inFence = false;
	const lines: string[] = [];
	for (const line of md.split("\n")) {
		if (line.trimStart().startsWith("```")) inFence = !inFence;
		else if (line.trim()) lines.push(inFence ? line : plainLine(line));
	}
	return lines.join("\n");
}

function plainLine(line: string): string {
	// Inline code is set aside first, so a `*` or `[` inside it is left alone.
	const code: string[] = [];
	return line
		.replace(/`([^`]+)`/g, (_, c: string) => `${code.push(c) - 1}`)
		.replace(/^\s*#{1,6}\s+/, "")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\*\*(\S(?:.*?\S)?)\*\*/g, "$1")
		.replace(/(^|\W)\*(\S(?:.*?\S)?)\*(?=\W|$)/g, "$1$2")
		.replace(/(\d+)/g, (_, i: string) => code[Number(i)] ?? "");
}

const NOTICES = [waitNotice, questionNotice, proposalNotice];

/**
 * Whether a banner held since `at` is still worth showing, judged on the task as
 * it is now: the same firing, question or proposal still pending. Freshness is
 * counted from when it was held, so a long stay in a project window doesn't
 * turn it stale.
 */
export function stillDue(key: string, latest: TaskDTO, at: number): boolean {
	const none = new Set<string>();
	return NOTICES.some((notice) => notice(latest, none, at)?.key === key);
}

export interface WaitNotifierOptions {
	/** The project of the window in front, or null when no project window is
	 *  (the main window, or another app). Other projects' banners wait until
	 *  the user leaves that window: release(). */
	focusedProject?(): string | null;
	/** Show one banner (tests); default: a macOS notification. */
	show?(notice: WaitNotice, task: TaskDTO): void;
}

export interface WaitNotifier {
	/** Call with every taskUpdated payload. */
	notify(task: TaskDTO): void;
	/** The user left a project window: show the held banners still due. */
	release(): void;
}

/**
 * Wire it. `onClick` brings the task's window forward and opens the task there.
 */
export function createWaitNotifier(
	onClick: (task: TaskDTO) => void,
	opts: WaitNotifierOptions = {},
): WaitNotifier {
	const shown = new Set<string>();
	// Banners held while a project window is in front, and the newest copy of
	// each held task, to check on release that it is still due.
	let held: { notice: WaitNotice; at: number; taskId: string }[] = [];
	const latest = new Map<string, TaskDTO>();
	// Electron drops a notification's handlers once it is garbage collected,
	// which turns a click into a no-op; hold each one until it is done with.
	const live = new Set<Notification>();
	const show =
		opts.show ??
		((notice: WaitNotice, task: TaskDTO) => {
			if (!Notification.isSupported()) return;
			const n = new Notification({ title: notice.title, body: notice.body });
			live.add(n);
			n.on("click", () => {
				live.delete(n);
				onClick(task);
			});
			n.on("close", () => live.delete(n));
			n.show();
		});

	const release = () => {
		const due = held.filter((h) => {
			const task = latest.get(h.taskId);
			return task != null && stillDue(h.notice.key, task, h.at);
		});
		held = [];
		// shortcut: every held banner shows at once; fold them into one summary
		// if a long stay in a project window ever leaves more than a handful.
		for (const h of due) {
			const task = latest.get(h.taskId);
			if (task) show(h.notice, task);
		}
		latest.clear();
	};

	return {
		notify(task) {
			if (held.some((h) => h.taskId === task.id)) latest.set(task.id, task);
			// A blur missed (a window closed in front): nothing holds them any more.
			const focused = opts.focusedProject?.() ?? null;
			if (focused === null && held.length) release();
			const now = Date.now();
			const notice =
				waitNotice(task, shown, now) ??
				questionNotice(task, shown, now) ??
				proposalNotice(task, shown, now);
			if (!notice) return;
			shown.add(notice.key);
			if (focused !== null && focused !== task.projectId) {
				held.push({ notice, at: now, taskId: task.id });
				latest.set(task.id, task);
				return;
			}
			show(notice, task);
		},
		release,
	};
}
