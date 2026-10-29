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
 */
import { randomUUID } from "node:crypto";
import { type AteamDb, repo, type TaskQuestion } from "@ateam/db";
import { CLEAR_QUESTION, MAX_QUESTION } from "./questions";

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
			| { behavior: "allow"; updatedPermissions?: unknown[] }
			| { behavior: "deny"; message: string };
	};
} | null;

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
			text: describeAsk(a.toolName, a.toolInput),
			options: choices.map((c) => c.label),
			allowText: false,
			askedAt: this.now(),
			choices,
			kind: "permission",
		};
		repo.updateTask(db, task.id, { question, column: "needs_attention", isUnread: true });
		this.deps.notify(task.id);

		let resolve!: (d: PermissionDecision) => void;
		const result = new Promise<PermissionDecision>((r) => {
			resolve = r;
		});
		const timer = setTimeout(() => this.release(question.id), this.deps.holdMs ?? HOLD_MS);
		this.pending.set(question.id, {
			taskId: task.id,
			terminalId: a.terminalId,
			questionId: question.id,
			suggestions: a.suggestions,
			askedAt: question.askedAt,
			resolve,
			timer,
		});
		// The hook's connection dropped (Claude cancelled it): nothing to answer any more.
		return { result, cancel: () => this.release(question.id) };
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
	answer(questionId: string, answer: string | null): void {
		const p = this.pending.get(questionId);
		if (!p) throw new Error("That prompt is no longer waiting. Answer it in the task's terminal.");
		if (answer === null) {
			this.release(questionId);
			return;
		}
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
			this.release(p.questionId);
		}
	}

	/** Every held request, answered with "no decision": the terminal keeps the prompt. */
	stop(): void {
		for (const id of [...this.pending.keys()]) this.release(id);
	}

	private release(questionId: string): void {
		const p = this.pending.get(questionId);
		if (p) this.finish(p, null, null);
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
				...(column ? { column, isUnread: false } : {}),
			});
			this.deps.notify(p.taskId);
		}
	}
}
