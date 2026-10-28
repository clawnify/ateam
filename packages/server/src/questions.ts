/**
 * Questions an agent asks the user (the ask_user board tool), answered from any
 * Ateam client instead of the agent's terminal.
 *
 * MCP has two ways to put UI in front of the user, and neither reaches us: MCP
 * Apps (`ui://` resources) and elicitation are both rendered by the MCP client,
 * which for a task is the agent's own CLI in a terminal. So the question is
 * Ateam's own: the agent files it on its task, every client renders it from
 * TaskDTO.question, and the answer goes back through the peer-message doors
 * (peer-messages.ts) as a message from the user. That makes the call return at
 * once, so it never trips an MCP tool timeout, and an agent that exited while
 * the user thought it over is resumed with the answer.
 *
 * One question per task: a new ask replaces the pending one. While one is
 * pending the card stays in Needs You, even across the agent's Stop.
 */
import { randomUUID } from "node:crypto";
import { type AteamDb, repo, type Task, type TaskQuestion } from "@ateam/db";
import type { OutsideSender, SendResult } from "./peer-messages";

export const MAX_QUESTION = 1000;
export const MAX_OPTIONS = 4;
export const MAX_OPTION = 80;
export const MAX_ANSWER = 4000;

/** The patch that ends a question, whoever ends it. */
export const CLEAR_QUESTION = { question: null } as const;

export interface AskRequest {
	taskId: string;
	text: string;
	options?: string[];
	allowText?: boolean;
}

export type AskVerdict =
	| { ok: true; question: Omit<TaskQuestion, "id" | "askedAt"> }
	| { ok: false; reason: string };

export function validateAsk(req: Omit<AskRequest, "taskId">): AskVerdict {
	const text = req.text.trim();
	if (!text) return { ok: false, reason: "the question is empty" };
	if (text.length > MAX_QUESTION)
		return {
			ok: false,
			reason: `the question is ${text.length} characters; keep it under ${MAX_QUESTION} and put detail in your reply`,
		};
	const options = [...new Set((req.options ?? []).map((o) => o.trim()).filter(Boolean))];
	if (options.length > MAX_OPTIONS)
		return { ok: false, reason: `give at most ${MAX_OPTIONS} options` };
	const long = options.find((o) => o.length > MAX_OPTION);
	if (long)
		return { ok: false, reason: `option "${long.slice(0, 30)}…" is over ${MAX_OPTION} characters` };
	// With nothing to pick from, the user has to be able to type.
	const allowText = options.length === 0 ? true : req.allowText !== false;
	return { ok: true, question: { text, options, allowText } };
}

/** File the question on its task and put the card in Needs You. */
export function applyAskUser(
	db: AteamDb,
	req: AskRequest,
	notify: (taskId: string) => void,
	now = Date.now(),
): { ok: boolean; reason: string } {
	const task = repo.getTask(db, req.taskId);
	if (!task) return { ok: false, reason: `no task ${req.taskId}` };
	const verdict = validateAsk(req);
	if (!verdict.ok) return verdict;
	repo.updateTask(db, task.id, {
		question: { id: randomUUID(), askedAt: now, ...verdict.question },
		column: "needs_attention",
		isUnread: true,
	});
	notify(task.id);
	return {
		ok: true,
		reason:
			"Asked. The user sees it on the board, in the Lead chat and on their phone. End your turn now and do not ask it again in your reply: their answer arrives as a message starting with [Ateam], and continues this conversation.",
	};
}

/** The column a hook event lands a card in, given a pending question: a Stop
 *  must not bury the question in Review. */
export function columnWithQuestion<C extends string>(task: Task, column: C): C | "needs_attention" {
	return task.question && column === "review" ? "needs_attention" : column;
}

/**
 * Answer the pending question (or dismiss it with null). The answer is
 * delivered before the question is cleared, so a refused delivery (the rate
 * cap) leaves it pending for another try rather than lost.
 */
export function answerQuestion(
	db: AteamDb,
	send: (sender: OutsideSender, req: { to: string; body: string }) => SendResult,
	req: { taskId: string; questionId: string; answer: string | null },
	notify: (taskId: string) => void,
): void {
	const task = repo.getTask(db, req.taskId);
	if (!task) throw new Error(`Task not found: ${req.taskId}`);
	const q = task.question;
	if (!q || q.id !== req.questionId)
		throw new Error("That question was already answered or replaced.");
	if (req.answer == null) {
		// Dismissed: handled somewhere else, nothing to tell the agent.
		repo.updateTask(db, task.id, { ...CLEAR_QUESTION, column: "review", isUnread: false });
		notify(task.id);
		return;
	}
	const answer = req.answer.trim();
	if (!answer) throw new Error("The answer is empty.");
	if (answer.length > MAX_ANSWER)
		throw new Error(`Keep the answer under ${MAX_ANSWER} characters.`);
	if (!q.allowText && !q.options.includes(answer))
		throw new Error(`Pick one of: ${q.options.join(", ")}.`);
	const res = send("user", {
		to: task.id,
		body: `You asked: ${q.text}\n\nThe user's answer: ${answer}`,
	});
	if (!res.ok) throw new Error(res.reason);
	repo.updateTask(db, task.id, { ...CLEAR_QUESTION, column: "running", isUnread: false });
	notify(task.id);
}
