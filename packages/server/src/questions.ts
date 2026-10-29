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
import { type AteamDb, type QuestionChoice, repo, type Task, type TaskQuestion } from "@ateam/db";
import type { OutsideSender, SendResult } from "./peer-messages";

/** Room for a mermaid diagram (rendered by every client) beside the question. */
export const MAX_QUESTION = 4000;
/** Options for a single choice: few enough to weigh side by side. */
export const MAX_OPTIONS = 4;
/** Rows of a checklist (select "many"): a list to tick through. */
export const MAX_CHECKLIST = 20;
export const MAX_OPTION = 80;
/** A typed answer; the message carrying it (with the quoted question) holds 8000. */
export const MAX_ANSWER = 6000;
/** How much of the question an answer quotes back. */
const QUOTE = 300;

/** The patch that ends a question, whoever ends it. */
export const CLEAR_QUESTION = { question: null } as const;

/** What ask_user hands over: the model's arguments, not yet trusted. */
export interface AskRequest {
	taskId: string;
	text: string;
	/** Labels, or objects with a label and what the agent knows about it. */
	options?: unknown[];
	allowText?: boolean;
	select?: unknown;
}

export type AskVerdict =
	| { ok: true; question: Omit<TaskQuestion, "id" | "askedAt"> }
	| { ok: false; reason: string };

const str = (v: unknown, max: number): string | undefined =>
	typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
const strs = (v: unknown, n: number, max: number): string[] | undefined => {
	const out = Array.isArray(v) ? v.map((x) => str(x, max)).filter((x): x is string => !!x) : [];
	return out.length ? out.slice(0, n) : undefined;
};
const RISKS = new Set(["low", "medium", "high"]);

function toChoice(raw: unknown): QuestionChoice | string {
	if (typeof raw === "string") return { label: raw.trim() };
	if (!raw || typeof raw !== "object") return "each option is a label or an object with a label";
	const o = raw as Record<string, unknown>;
	if (typeof o.label !== "string") return "each option object needs a label";
	const choice: QuestionChoice = { label: o.label.trim() };
	const description = str(o.description, 300);
	const pros = strs(o.pros, 4, 120);
	const cons = strs(o.cons, 4, 120);
	if (description) choice.description = description;
	if (pros) choice.pros = pros;
	if (cons) choice.cons = cons;
	if (typeof o.risk === "string" && RISKS.has(o.risk))
		choice.risk = o.risk as QuestionChoice["risk"];
	if (o.recommended === true) choice.recommended = true;
	if (o.checked === true) choice.checked = true;
	return choice;
}

export function validateAsk(req: Omit<AskRequest, "taskId">): AskVerdict {
	const text = req.text.trim();
	if (!text) return { ok: false, reason: "the question is empty" };
	if (text.length > MAX_QUESTION)
		return {
			ok: false,
			reason: `the question is ${text.length} characters; keep it under ${MAX_QUESTION} and put the detail in your reply`,
		};
	const select = req.select === "many" ? "many" : "one";

	const choices: QuestionChoice[] = [];
	for (const raw of req.options ?? []) {
		const c = toChoice(raw);
		if (typeof c === "string") return { ok: false, reason: c };
		if (!c.label) continue;
		if (c.label.length > MAX_OPTION)
			return {
				ok: false,
				reason: `option "${c.label.slice(0, 30)}…" is over ${MAX_OPTION} characters`,
			};
		if (choices.some((x) => x.label === c.label)) continue;
		choices.push(c);
	}
	const cap = select === "many" ? MAX_CHECKLIST : MAX_OPTIONS;
	if (choices.length > cap)
		return {
			ok: false,
			reason:
				select === "many"
					? `a checklist holds at most ${MAX_CHECKLIST} rows`
					: `give at most ${MAX_OPTIONS} options; for a longer list to tick through, use select "many"`,
		};
	if (select === "many" && choices.length === 0)
		return { ok: false, reason: 'a checklist (select "many") needs options to tick' };
	if (choices.filter((c) => c.recommended).length > 1)
		return { ok: false, reason: "recommend at most one option" };

	const options = choices.map((c) => c.label);
	const rich = select === "many" || choices.some((c) => Object.keys(c).length > 1);
	const question: Omit<TaskQuestion, "id" | "askedAt"> = {
		text,
		options,
		// A checklist is answered by what is ticked; with nothing to pick from,
		// the user has to be able to type.
		allowText: select === "many" ? false : options.length === 0 ? true : req.allowText !== false,
		...(rich ? { choices } : {}),
		...(select === "many" ? { select } : {}),
	};
	return { ok: true, question };
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
	req: {
		taskId: string;
		questionId: string;
		answer: string | string[] | null;
		/** "lead": the Lead chat passed on what the user told it, so the agent is
		 *  told it came through the Lead rather than from the user's own click. */
		via?: "lead";
	},
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
	// The agent has its question in its own context: quoting its first line is
	// enough to say which one, and keeps a long question plus a long answer
	// under the message cap.
	const asked = (q.text.split("\n").find((l) => l.trim()) ?? q.text).slice(0, QUOTE);
	const res = send(req.via === "lead" ? "lead" : "user", {
		to: task.id,
		body: `Answer to your ask_user question "${asked}"\n\n${answerText(q, req.answer)}`,
	});
	if (!res.ok) throw new Error(res.reason);
	repo.updateTask(db, task.id, { ...CLEAR_QUESTION, column: "running", isUnread: false });
	notify(task.id);
}

/** The answer as the agent reads it; throws when it doesn't fit the question. */
function answerText(q: TaskQuestion, answer: string | string[]): string {
	// A checklist: what the user left ticked, and what they didn't.
	if (q.select === "many") {
		const picked = [...new Set((Array.isArray(answer) ? answer : [answer]).map((a) => a.trim()))];
		const unknown = picked.find((a) => !q.options.includes(a));
		if (unknown !== undefined) throw new Error(`"${unknown}" is not on the list.`);
		const left = q.options.filter((o) => !picked.includes(o));
		const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
		return [
			picked.length ? `The user ticked:\n${list(picked)}` : "The user ticked nothing.",
			left.length ? `They left unticked:\n${list(left)}` : "",
		]
			.filter(Boolean)
			.join("\n\n");
	}
	const text = (Array.isArray(answer) ? answer.join(", ") : answer).trim();
	if (!text) throw new Error("The answer is empty.");
	if (text.length > MAX_ANSWER) throw new Error(`Keep the answer under ${MAX_ANSWER} characters.`);
	if (!q.allowText && !q.options.includes(text))
		throw new Error(`Pick one of: ${q.options.join(", ")}.`);
	return `The user's answer: ${text}`;
}
