/**
 * Claude Code's permission prompts ("Allow this command?"), answerable from any
 * Ateam client instead of only in the agent's terminal.
 *
 * Claude runs a PermissionRequest hook the moment it is about to ask (Ateam's
 * `permission.sh`), and the hook can return the decision. Verified on Claude
 * Code 2.1.312 in a real terminal: the dialog is shown while the hook runs, and
 * whichever decides first applies. An Enter in the terminal while the hook is
 * still waiting runs the command at once, and the hook's late answer is
 * ignored. So the hook can wait for the user's click without taking the
 * terminal away from them.
 *
 * The prompt becomes the task's question (kind "permission"), so it shows
 * where every ask_user question does: the board, the Lead chat, the task panel,
 * the phone. The click resolves the request the hook holds open; the answer
 * never goes through the peer-message doors, because the agent is mid-turn and
 * waiting on exactly this.
 *
 * Claude's own question tool, AskUserQuestion, asks through the same hook. It
 * is shown as the question it is (kind "askUserQuestion"), one card per
 * question, and answered with `updatedInput.answers` keyed by question text.
 * Verified on Claude Code 2.1.316: that closes the terminal's dialog and the
 * agent gets the answers; a plain allow leaves the dialog up, unanswered.
 */
import { randomUUID } from "node:crypto";
import { type AteamDb, repo, type TaskQuestion } from "@ateam/db";
import { CLEAR_QUESTION, MAX_ANSWER, MAX_QUESTION } from "./questions";

/** What Claude's PermissionRequest hook hands over (its stdin JSON). */
export interface PermissionAsk {
	terminalId: string;
	toolName: string;
	toolInput: Record<string, unknown>;
	/** Claude's own "don't ask again" rules for this call, when it has them. */
	suggestions: unknown[];
}

/** The hook's stdout: Claude's PermissionRequest decision, or null for none. */
export type PermissionDecision = {
	hookSpecificOutput: {
		hookEventName: "PermissionRequest";
		decision:
			| {
					behavior: "allow";
					updatedPermissions?: unknown[];
					updatedInput?: Record<string, unknown>;
			  }
			| { behavior: "deny"; message: string };
	};
} | null;

export const ASK_TOOL = "AskUserQuestion";

/** One question of an AskUserQuestion call, as Claude hands it over. */
interface AskedQuestion {
	question: string;
	header: string;
	options: { label: string; description?: string; preview?: string }[];
	multiSelect: boolean;
}

/** The call's questions, or null when they aren't the shape Claude documents
 *  (then it is shown as a plain permission prompt, as before). */
export function parseQuestions(input: Record<string, unknown>): AskedQuestion[] | null {
	const raw = input.questions;
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const out: AskedQuestion[] = [];
	for (const q of raw as Record<string, unknown>[]) {
		if (typeof q?.question !== "string" || !Array.isArray(q.options)) return null;
		const options = (q.options as Record<string, unknown>[]).filter(
			(o) => typeof o?.label === "string",
		) as AskedQuestion["options"];
		if (options.length === 0) return null;
		out.push({
			question: q.question,
			header: typeof q.header === "string" ? q.header : "",
			options,
			multiSelect: q.multiSelect === true,
		});
	}
	return out;
}

const RECOMMENDED = /\s*\(recommended\)\s*$/i;

/** Question `i` of the call as a card: Claude's "(Recommended)" label suffix
 *  becomes the badge, and option previews are drawn under the question. */
function askCard(qs: AskedQuestion[], i: number): Omit<TaskQuestion, "id" | "askedAt"> {
	const q = qs[i] as AskedQuestion;
	const choices = q.options.map((o) => ({
		label: o.label.replace(RECOMMENDED, "") || o.label,
		...(o.description ? { description: o.description } : {}),
		...(RECOMMENDED.test(o.label) ? { recommended: true } : {}),
	}));
	const previews = q.options
		.filter((o) => typeof o.preview === "string" && o.preview.trim())
		.map(
			(o) =>
				`**${o.label.replace(RECOMMENDED, "")}**\n\n\`\`\`\n${fence(o.preview as string)}\n\`\`\``,
		);
	const step = qs.length > 1 ? `*${q.header || "Question"} · ${i + 1} of ${qs.length}*\n\n` : "";
	return {
		text: [step + q.question, ...previews].join("\n\n").slice(0, MAX_QUESTION),
		options: choices.map((c) => c.label),
		// Claude's dialog always offers "Type something" beside the options.
		allowText: !q.multiSelect,
		choices,
		...(q.multiSelect ? { select: "many" as const } : {}),
		kind: "askUserQuestion",
	};
}

export const ALLOW = "Allow";
export const ALLOW_ALWAYS = "Always allow";
export const DENY = "Deny";

/** How long the hook's request is held: under the hook's own 600s timeout, so
 *  Claude never cancels it mid-answer; the terminal dialog stays up regardless. */
export const HOLD_MS = 570_000;

interface Pending {
	taskId: string;
	terminalId: string;
	questionId: string;
	suggestions: unknown[];
	askedAt: number;
	resolve: (d: PermissionDecision) => void;
	timer: ReturnType<typeof setTimeout>;
	/** An AskUserQuestion call: its input, its questions, the answers so far
	 *  and which question's card is up. `questionId` follows that card. */
	asked?: {
		input: Record<string, unknown>;
		questions: AskedQuestion[];
		answers: Record<string, string>;
		index: number;
	};
}

const fence = (s: string) => s.replace(/```/g, "ʼʼʼ");

/** The prompt as the user reads it: what the agent wants to do, in its own terms. */
export function describeAsk(toolName: string, input: Record<string, unknown>): string {
	const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
	let text: string;
	if (toolName === "Bash") {
		const desc = str("description");
		text = `**Run a command?**\n\n\`\`\`sh\n${fence(str("command"))}\n\`\`\`${desc ? `\n${desc}` : ""}`;
	} else if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(toolName)) {
		const verb = toolName === "Write" ? "Write" : "Edit";
		text = `**${verb} \`${str("file_path") || str("notebook_path")}\`?**`;
	} else if (toolName === "WebFetch") {
		text = `**Fetch ${str("url")}?**`;
	} else {
		const json = JSON.stringify(input, null, 2);
		text = `**Use ${toolName}?**\n\n\`\`\`json\n${fence(json.slice(0, 1500))}${json.length > 1500 ? "\n…" : ""}\n\`\`\``;
	}
	return text.slice(0, MAX_QUESTION);
}

/** "Bash(npm run lint)" for an addRules suggestion, so "Always allow" says what it allows. */
export function ruleText(suggestions: unknown[]): string | null {
	for (const s of suggestions) {
		const o = (s ?? {}) as { type?: string; rules?: { toolName?: string; ruleContent?: string }[] };
		const r = o.type === "addRules" ? o.rules?.[0] : undefined;
		if (r?.toolName) return r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName;
	}
	return null;
}

export interface PermissionBridgeDeps {
	db: AteamDb;
	notify: (taskId: string) => void;
	now?: () => number;
	holdMs?: number;
}

export class PermissionBridge {
	private pending = new Map<string, Pending>();
	private readonly now: () => number;

	constructor(private deps: PermissionBridgeDeps) {
		this.now = deps.now ?? Date.now;
	}

	/** The hook asks: file the question and hold its request until someone decides. */
	ask(a: PermissionAsk): { result: Promise<PermissionDecision>; cancel: () => void } {
		const { db } = this.deps;
		const session = repo.getSessionByTerminal(db, a.terminalId);
		const task = session ? repo.getTask(db, session.taskId) : undefined;
		if (!task) return { result: Promise.resolve(null), cancel: () => {} };
		// A newer prompt from the same terminal replaces an older one still showing.
		this.settle(a.terminalId);

		const questions = a.toolName === ASK_TOOL ? parseQuestions(a.toolInput) : null;
		const always = a.suggestions.length > 0 ? ruleText(a.suggestions) : null;
		const choices = [
			{ label: ALLOW, description: "Just this once.", recommended: true },
			...(a.suggestions.length > 0
				? [
						{
							label: ALLOW_ALWAYS,
							description: always
								? `And don't ask again for ${always}.`
								: "And don't ask again for this.",
						},
					]
				: []),
			{ label: DENY, description: "The agent is told you said no." },
		];
		const question: TaskQuestion = {
			id: randomUUID(),
			askedAt: this.now(),
			...(questions
				? askCard(questions, 0)
				: {
						text: describeAsk(a.toolName, a.toolInput),
						options: choices.map((c) => c.label),
						allowText: false,
						choices,
						kind: "permission" as const,
					}),
		};
		repo.updateTask(db, task.id, { question, column: "needs_attention", isUnread: true });
		this.deps.notify(task.id);

		let resolve!: (d: PermissionDecision) => void;
		const result = new Promise<PermissionDecision>((r) => {
			resolve = r;
		});
		const p: Pending = {
			taskId: task.id,
			terminalId: a.terminalId,
			questionId: question.id,
			suggestions: a.suggestions,
			askedAt: question.askedAt,
			resolve,
			timer: setTimeout(() => this.release(p), this.deps.holdMs ?? HOLD_MS),
			...(questions ? { asked: { input: a.toolInput, questions, answers: {}, index: 0 } } : {}),
		};
		this.pending.set(question.id, p);
		// The hook's connection dropped (Claude cancelled it): nothing to answer any more.
		return { result, cancel: () => this.release(p) };
	}

	/** Is this question one the bridge holds a request for? */
	holds(questionId: string): boolean {
		return this.pending.has(questionId);
	}

	/**
	 * The user decided in an Ateam client. Throws when the prompt is no longer
	 * waiting (answered in the terminal, timed out, or the app restarted), so the
	 * client says so instead of looking like it worked.
	 */
	answer(questionId: string, value: string | string[] | null): void {
		const p = this.pending.get(questionId);
		if (!p) throw new Error("That prompt is no longer waiting. Answer it in the task's terminal.");
		if (value === null) {
			this.release(p);
			return;
		}
		if (p.asked) {
			this.answerAsked(p, p.asked, value);
			return;
		}
		const answer = Array.isArray(value) ? value[0] : value;
		let decision: PermissionDecision;
		if (answer === ALLOW || answer === ALLOW_ALWAYS) {
			decision = {
				hookSpecificOutput: {
					hookEventName: "PermissionRequest",
					decision: {
						behavior: "allow",
						...(answer === ALLOW_ALWAYS ? { updatedPermissions: p.suggestions } : {}),
					},
				},
			};
		} else if (answer === DENY) {
			decision = {
				hookSpecificOutput: {
					hookEventName: "PermissionRequest",
					decision: { behavior: "deny", message: "The user denied this from the Ateam app." },
				},
			};
		} else throw new Error(`Pick one of: ${ALLOW}, ${DENY}.`);
		this.finish(p, decision, "running");
	}

	/** One question of an AskUserQuestion call answered: the next one gets its
	 *  card, and the last one hands Claude every answer at once. */
	private answerAsked(p: Pending, asked: NonNullable<Pending["asked"]>, value: string | string[]) {
		const { db, notify } = this.deps;
		const q = asked.questions[asked.index] as AskedQuestion;
		// Claude's own form: a multi-select answer is its labels joined with ", ".
		const text = Array.isArray(value) ? value.join(", ") || "None" : value.trim();
		if (!text) throw new Error("Pick an option or type an answer.");
		asked.answers[q.question] = text.slice(0, MAX_ANSWER);
		asked.index++;
		if (asked.index < asked.questions.length) {
			// A new id, so a late answer to the last card can't land on this one;
			// the call's askedAt, because Claude asked them all at once (and the
			// desktop notifies once per askedAt, not once per card).
			const next: TaskQuestion = {
				id: randomUUID(),
				askedAt: p.askedAt,
				...askCard(asked.questions, asked.index),
			};
			this.pending.delete(p.questionId);
			p.questionId = next.id;
			this.pending.set(next.id, p);
			repo.updateTask(db, p.taskId, { question: next, column: "needs_attention" });
			notify(p.taskId);
			return;
		}
		this.finish(
			p,
			{
				hookSpecificOutput: {
					hookEventName: "PermissionRequest",
					decision: { behavior: "allow", updatedInput: { ...asked.input, answers: asked.answers } },
				},
			},
			"running",
		);
	}

	/**
	 * The agent moved on in its terminal (the user answered there, or it was
	 * interrupted): stop holding its prompt and take the card down. A PreToolUse
	 * fires for the very call that asks, just before the hook, so activity in the
	 * first second after the ask is that, not an answer.
	 */
	settle(terminalId: string, eventType?: string): void {
		for (const p of this.pending.values()) {
			if (p.terminalId !== terminalId) continue;
			if (eventType === "Working" && this.now() - p.askedAt < 1000) continue;
			this.release(p);
		}
	}

	/** Every held request, answered with "no decision": the terminal keeps the prompt. */
	stop(): void {
		for (const p of [...this.pending.values()]) this.release(p);
	}

	/** Hand the prompt back to the terminal, if it is still held. */
	private release(p: Pending): void {
		if (this.pending.get(p.questionId) === p) this.finish(p, null, null);
	}

	private finish(p: Pending, decision: PermissionDecision, column: "running" | null): void {
		clearTimeout(p.timer);
		this.pending.delete(p.questionId);
		p.resolve(decision);
		const task = repo.getTask(this.deps.db, p.taskId);
		// Only this prompt's card comes down: an ask_user question asked since stays.
		if (task?.question?.id === p.questionId) {
			repo.updateTask(this.deps.db, p.taskId, {
				...CLEAR_QUESTION,
				// The agent is past its prompt: left at awaiting_input, the card
				// would be held in Needs You (repo.updateTask).
				...(column ? { column, agentStatus: "running" as const, isUnread: false } : {}),
			});
			this.deps.notify(p.taskId);
		}
	}
}
