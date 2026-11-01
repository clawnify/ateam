/**
 * Tasks and loops an agent proposes for the user to start (the propose_task and
 * propose_loop board tools).
 *
 * The agent can't create them itself: a task is a new worktree and a running
 * agent, a loop spends tokens on a schedule, so the user decides. The proposal
 * is filed on the agent's own task, and the desktop opens the New task or New
 * loop dialog filled in from it, editable, when that task is on screen (a
 * proposal from a task the user isn't looking at would arrive with no context).
 * Creating it there is the ordinary create; the client then clears the
 * proposal. The agent is not told the outcome: it isn't waiting on it, and a
 * message would wake a stopped agent for nothing.
 *
 * Several can be pending (an agent splitting work proposes a few follow-ups),
 * oldest first. While any is, the card is held in Needs You (repo.updateTask).
 */
import { randomUUID } from "node:crypto";
import { type AteamDb, repo, type TaskProposal } from "@ateam/db";

export const MAX_NAME = 60;
/** A first instruction can carry a whole brief, but not a transcript. */
export const MAX_PROMPT = 20_000;
export const MAX_REASON = 300;
export const MAX_FOLLOW_UP = 2_000;
/** Pending on one task at once: enough to split work, few enough to go through. */
export const MAX_PENDING = 5;
/** The longest loop interval: a month. */
export const MAX_EVERY_MINUTES = 30 * 24 * 60;
const AGENTS = new Set(["claude", "codex", "opencode"]);

/** What propose_task / propose_loop hand over: the model's arguments, not yet trusted. */
export interface ProposeRequest {
	taskId: string;
	kind: "task" | "loop";
	name?: unknown;
	prompt?: unknown;
	reason?: unknown;
	agent?: unknown;
	yolo?: unknown;
	everyMinutes?: unknown;
	dailyAt?: unknown;
	followUp?: unknown;
}

type Verdict =
	| { ok: true; proposal: Omit<TaskProposal, "id" | "proposedAt"> }
	| { ok: false; reason: string };

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function validateProposal(req: Omit<ProposeRequest, "taskId">): Verdict {
	const name = text(req.name);
	const prompt = text(req.prompt);
	if (!name) return { ok: false, reason: "give it a name" };
	if (!prompt) return { ok: false, reason: "give it a prompt: the new agent's first instruction" };
	if (name.length > MAX_NAME)
		return {
			ok: false,
			reason: `the name is ${name.length} characters; keep it under ${MAX_NAME}`,
		};
	if (prompt.length > MAX_PROMPT)
		return {
			ok: false,
			reason: `the prompt is ${prompt.length} characters; keep it under ${MAX_PROMPT}`,
		};
	const reason = text(req.reason);
	if (reason.length > MAX_REASON)
		return {
			ok: false,
			reason: `the reason is over ${MAX_REASON} characters; say it in a line or two`,
		};
	const agent = text(req.agent);
	if (agent && !AGENTS.has(agent))
		return { ok: false, reason: `agent is one of ${[...AGENTS].join(", ")}` };

	const proposal: Omit<TaskProposal, "id" | "proposedAt"> = {
		kind: req.kind,
		name,
		prompt,
		...(reason ? { reason } : {}),
		...(agent ? { agentId: agent } : {}),
		...(req.yolo === true ? { yolo: true } : {}),
	};
	if (req.kind === "task") return { ok: true, proposal };

	const every = req.everyMinutes;
	const daily = text(req.dailyAt);
	if ((every == null) === !daily)
		return {
			ok: false,
			reason: "give the loop one schedule: everyMinutes, or dailyAt as HH:MM",
		};
	if (every != null) {
		if (
			typeof every !== "number" ||
			!Number.isInteger(every) ||
			every < 1 ||
			every > MAX_EVERY_MINUTES
		)
			return {
				ok: false,
				reason: `everyMinutes is a whole number of minutes from 1 to ${MAX_EVERY_MINUTES}`,
			};
		proposal.everyMinutes = every;
	} else {
		const m = /^(\d{1,2}):(\d{2})$/.exec(daily);
		if (!m || Number(m[1]) > 23 || Number(m[2]) > 59)
			return {
				ok: false,
				reason: `dailyAt is a time of day as HH:MM, like 09:00 (got "${daily}")`,
			};
		proposal.dailyAt = `${m[1]!.padStart(2, "0")}:${m[2]}`;
	}
	const followUp = text(req.followUp);
	if (followUp.length > MAX_FOLLOW_UP)
		return { ok: false, reason: `the follow-up is over ${MAX_FOLLOW_UP} characters` };
	if (followUp) proposal.followUp = followUp;
	return { ok: true, proposal };
}

/** File the proposal on its task, which puts the card in Needs You. */
export function applyPropose(
	db: AteamDb,
	req: ProposeRequest,
	notify: (taskId: string) => void,
	now = Date.now(),
): { ok: boolean; reason: string } {
	const task = repo.getTask(db, req.taskId);
	if (!task) return { ok: false, reason: `no task ${req.taskId}` };
	const verdict = validateProposal(req);
	if (!verdict.ok) return verdict;
	const p = verdict.proposal;
	// The same name again is the agent revising its proposal, not a second one.
	const rest = (task.proposals ?? []).filter((x) => !(x.kind === p.kind && x.name === p.name));
	if (rest.length >= MAX_PENDING)
		return {
			ok: false,
			reason: `${MAX_PENDING} proposals are already waiting on the user; let them decide on those first`,
		};
	repo.updateTask(db, task.id, {
		proposals: [...rest, { id: randomUUID(), proposedAt: now, ...p }],
		column: "needs_attention",
		isUnread: true,
	});
	notify(task.id);
	const what = p.kind === "task" ? "task" : "loop";
	return {
		ok: true,
		reason: `Proposed. The user sees a New ${what} dialog filled in with it when they open this task, can edit it, and creates or dismisses it. Nothing is created until they confirm, and you are not told either way. Say in a line of your reply what you proposed and why; do not wait for it.`,
	};
}

/**
 * Drop a proposal once the user created it or dismissed it. One already gone
 * (cleared from another window) is fine: the user's intent holds either way.
 * The last one out lets the card leave Needs You, to wherever its agent is.
 */
export function clearProposal(
	db: AteamDb,
	req: { taskId: string; proposalId: string },
	notify: (taskId: string) => void,
): void {
	const task = repo.getTask(db, req.taskId);
	if (!task) throw new Error(`Task not found: ${req.taskId}`);
	const before = task.proposals ?? [];
	const proposals = before.filter((p) => p.id !== req.proposalId);
	if (proposals.length === before.length) return;
	repo.updateTask(db, task.id, {
		proposals,
		isUnread: false,
		// Still held there if something else waits on the user (repo.updateTask).
		...(proposals.length === 0 && task.column === "needs_attention"
			? { column: task.agentStatus === "running" ? "running" : "review" }
			: {}),
	});
	notify(task.id);
}
