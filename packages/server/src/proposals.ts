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
 * proposal, saying whether it created it (and what) or dismissed it.
 *
 * The agent is not woken for that outcome: it isn't waiting on it, and a
 * message would cost a turn, or restart a stopped agent, for nothing. But it
 * must not go on believing its proposal is still waiting: one did, proposed it
 * again to revise it, and put a duplicate on the board for a task the user had
 * already started. So the outcome is kept on the proposing task
 * (`proposalOutcomes`) and reaches the agent without waking it, three ways:
 *   - its next turn: the UserPromptSubmit hook (Claude, and Codex, which shares
 *     the schema) answers with a note as `additionalContext`, once;
 *   - get_board lists the proposals made in its task with their outcomes;
 *   - propose_task refuses a name the user already created a task from while
 *     that task is in play, and points at send_message instead.
 * Outcomes belong to the task, not to the terminal that proposed: a restarted
 * agent gets a new terminal, and every tab of a task shares its board card.
 *
 * Several can be pending (an agent splitting work proposes a few follow-ups),
 * oldest first. While any is, the card is held in Needs You (repo.updateTask).
 */
import { randomUUID } from "node:crypto";
import { type AteamDb, type ProposalOutcome, repo, type Task, type TaskProposal } from "@ateam/db";

export const MAX_NAME = 60;
/** A first instruction can carry a whole brief, but not a transcript. */
export const MAX_PROMPT = 20_000;
export const MAX_REASON = 300;
export const MAX_FOLLOW_UP = 2_000;
/** Pending on one task at once: enough to split work, few enough to go through. */
export const MAX_PENDING = 5;
/** Decided proposals kept on a task: enough for a long session's follow-ups. */
export const MAX_OUTCOMES = 20;
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
	const earlier = latestOutcome(task, p.kind, p.name);
	if (earlier?.outcome === "created") {
		const refusal = alreadyCreated(db, earlier);
		if (refusal) {
			markTold(db, task, [earlier.id]);
			return { ok: false, reason: refusal };
		}
	}
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
	const wasDismissed = earlier?.outcome === "dismissed";
	if (wasDismissed) markTold(db, task, [earlier.id]);
	const dismissed = wasDismissed
		? ` The user dismissed a ${what} proposed under this name before; say in your reply what changed since.`
		: "";
	return {
		ok: true,
		reason: `Proposed. The user sees a New ${what} dialog filled in with it when they open this task, can edit it, and creates or dismisses it. Nothing is created until they confirm. You are not woken for their decision: get_board lists it, and a Claude or Codex session gets a note about it when its next turn starts. Say in a line of your reply what you proposed and why; do not wait for it.${dismissed}`,
	};
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The newest decision on a proposal of this kind and name, if any. */
function latestOutcome(
	task: Task,
	kind: TaskProposal["kind"],
	name: string,
): ProposalOutcome | undefined {
	return (task.proposalOutcomes ?? []).findLast((o) => o.kind === kind && sameName(o.name, name));
}

/**
 * Why proposing `o` again is refused, or null when it may be proposed again:
 * the task made from it is merged or archived, or the loop is gone. A task
 * created on another engine can't be looked up from here, so it is refused
 * with a way to find it.
 */
function alreadyCreated(db: AteamDb, o: ProposalOutcome): string | null {
	const createdName = o.created?.name ?? o.name;
	if (o.kind === "loop") {
		const loop = repo.listLoops(db).find((l) => l.name != null && sameName(l.name, createdName));
		if (!loop) return null;
		return `The user already created a loop from your proposal "${o.name}" ("${loop.name}"); proposing it again would only put a duplicate on the board. The user edits a loop in Loops: say in your reply what you would change.`;
	}
	const made = o.created?.id ? repo.getTask(db, o.created.id) : undefined;
	if (made && (made.column === "merged" || made.archivedAt != null)) return null;
	if (made)
		return `The user already created a task from your proposal "${o.name}": "${made.name}" (task ${made.id}, ${made.column}). Proposing it again would only put a duplicate on the board. To change or add to its work, send it a message with send_message (to: ${made.id}). Propose again only for different work, under a different name.`;
	return `The user already created a task from your proposal "${o.name}" ("${createdName}"), but it is not on this board: it may be on another machine (list_peers with search finds it) or deleted. To change its work, send it a message with send_message. If it is gone and the work still needs doing, propose it under a different name.`;
}

/** Mark these outcomes told, so the next turn's note leaves them out. */
function markTold(db: AteamDb, task: Task, ids: string[]): void {
	const all = task.proposalOutcomes ?? [];
	if (!all.some((o) => ids.includes(o.id) && !o.told)) return;
	repo.updateTask(db, task.id, {
		proposalOutcomes: all.map((o) => (ids.includes(o.id) ? { ...o, told: true } : o)),
	});
}

/** One outcome as a line for the agent. */
function describeOutcome(db: AteamDb, o: ProposalOutcome): string {
	const what = o.kind === "task" ? "task" : "loop";
	if (o.outcome === "dismissed") return `- Dismissed the ${what} proposed as "${o.name}".`;
	const createdName = o.created?.name ?? o.name;
	const renamed = sameName(createdName, o.name) ? "" : ` as "${createdName}"`;
	if (o.kind === "loop") return `- Created the loop proposed as "${o.name}"${renamed}.`;
	const made = o.created?.id ? repo.getTask(db, o.created.id) : undefined;
	if (!made)
		return `- Created the task proposed as "${o.name}"${renamed} (not on this board: another machine, or deleted).`;
	return `- Created the task proposed as "${o.name}": "${made.name}" (task ${made.id}, ${made.column}). To change its work, send it a message with send_message; do not propose it again.`;
}

/**
 * The note for an agent's next turn: what the user did with this task's
 * proposals since it was last told, or undefined when nothing new. Marks them
 * told, so each reaches the agent once.
 */
export function takeProposalNote(db: AteamDb, taskId: string): string | undefined {
	const task = repo.getTask(db, taskId);
	const fresh = (task?.proposalOutcomes ?? []).filter((o) => !o.told);
	if (!task || fresh.length === 0) return undefined;
	markTold(
		db,
		task,
		fresh.map((o) => o.id),
	);
	return [
		"Ateam, not the user: since you were last told, the user decided on proposals made in this task (propose_task / propose_loop).",
		...fresh.map((o) => describeOutcome(db, o)),
	].join("\n");
}

/** One proposal made in a task, for get_board. */
export interface ProposalStatusView {
	kind: "task" | "loop";
	name: string;
	status: "waiting for the user" | "created" | "dismissed";
	/** What the user created from it, as it stands now. */
	created?: { name: string; taskId?: string; column?: string };
}

/**
 * The proposals made in a task, pending and decided, for its agent's get_board.
 * Reading them is being told, so the next turn's note leaves them out.
 */
export function proposalsOfTask(db: AteamDb, taskId: string): ProposalStatusView[] {
	const task = repo.getTask(db, taskId);
	if (!task) return [];
	const outcomes = task.proposalOutcomes ?? [];
	markTold(
		db,
		task,
		outcomes.map((o) => o.id),
	);
	return [
		...outcomes.map((o): ProposalStatusView => {
			if (o.outcome === "dismissed") return { kind: o.kind, name: o.name, status: "dismissed" };
			const made = o.kind === "task" && o.created?.id ? repo.getTask(db, o.created.id) : undefined;
			const created = made
				? { name: made.name, taskId: made.id, column: made.column }
				: { name: o.created?.name ?? o.name, ...(o.created?.id ? { taskId: o.created.id } : {}) };
			return { kind: o.kind, name: o.name, status: "created", created };
		}),
		...(task.proposals ?? []).map(
			(p): ProposalStatusView => ({ kind: p.kind, name: p.name, status: "waiting for the user" }),
		),
	];
}

/** What the client says the user did with a proposal (tasks:clearProposal). */
export interface ClearProposalRequest {
	taskId: string;
	proposalId: string;
	/** Absent from a client older than protocol v38: then nothing is recorded,
	 *  since a created proposal and a dismissed one look the same. */
	outcome?: "created" | "dismissed";
	/** What was created from it, as the user saved it. */
	created?: { id?: string; name: string };
}

/**
 * Drop a proposal once the user created it or dismissed it, and keep what they
 * did for the agent (see the header). One already gone (cleared from another
 * window) is fine: the user's intent holds either way. The last one out lets
 * the card leave Needs You, to wherever its agent is.
 */
export function clearProposal(
	db: AteamDb,
	req: ClearProposalRequest,
	notify: (taskId: string) => void,
	now = Date.now(),
): void {
	const task = repo.getTask(db, req.taskId);
	if (!task) throw new Error(`Task not found: ${req.taskId}`);
	const before = task.proposals ?? [];
	const gone = before.find((p) => p.id === req.proposalId);
	if (!gone) return;
	const proposals = before.filter((p) => p !== gone);
	const outcome = outcomeOf(gone, req, now);
	repo.updateTask(db, task.id, {
		proposals,
		...(outcome
			? { proposalOutcomes: [...(task.proposalOutcomes ?? []), outcome].slice(-MAX_OUTCOMES) }
			: {}),
		isUnread: false,
		// Still held there if something else waits on the user (repo.updateTask).
		...(proposals.length === 0 && task.column === "needs_attention"
			? { column: task.agentStatus === "running" ? "running" : "review" }
			: {}),
	});
	notify(task.id);
}

/** The record kept for a cleared proposal, from the client's untrusted word. */
function outcomeOf(
	p: TaskProposal,
	req: ClearProposalRequest,
	now: number,
): ProposalOutcome | undefined {
	if (req.outcome !== "created" && req.outcome !== "dismissed") return undefined;
	const name = typeof req.created?.name === "string" ? req.created.name.trim().slice(0, 200) : "";
	const id = typeof req.created?.id === "string" ? req.created.id.trim().slice(0, 100) : "";
	return {
		id: p.id,
		kind: p.kind,
		name: p.name,
		outcome: req.outcome,
		...(req.outcome === "created" && (name || id)
			? { created: { ...(id ? { id } : {}), name: name || p.name } }
			: {}),
		at: now,
	};
}
