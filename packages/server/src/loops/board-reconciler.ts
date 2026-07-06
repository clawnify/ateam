import type { Task } from "@ateam/db";
import { repo } from "@ateam/db";
import { detectMerged } from "@ateam/git-core";
import { agentAlive } from "./session-liveness";
import type { LoopContext, LoopDefinition } from "./types";

const ID = "board-reconciler";

/** Don't hit `gh`/`git` for the same task more than once per minute. */
const NET_THROTTLE_MS = 60_000;
/** Self-paced bounds: tight while agents work, loose when the board is quiet. */
const MIN_MS = 5_000;
const MAX_MS = 120_000;

/** Has this task produced something worth reviewing? */
function hasReviewableWork(task: Task): boolean {
	return task.prNumber != null || (task.gitStatus?.ahead ?? 0) > 0;
}

/**
 * The board reconciler: a self-paced loop that realigns kanban columns with
 * ground truth for the cases the live agent hooks can't see —
 *   • a PR merged outside Ateam (on github.com or the agent's own terminal),
 *   • an agent that died WITHOUT firing Stop, leaving a card stuck in `running`.
 * Deterministic, no LLM. It backs off when the board is idle and tightens when
 * an agent is active. Built as a factory so its per-task network throttle is
 * private loop state rather than module-global.
 */
export function createBoardReconciler(): LoopDefinition {
	const lastNetCheck = new Map<string, number>();

	async function run(ctx: LoopContext) {
		const { db } = ctx;
		let merged = 0;
		let unstuck = 0;
		let anyAgentAlive = false;
		let openTasks = 0;

		for (const project of repo.listProjects(db)) {
			for (const task of repo.listTasks(db, project.id)) {
				if (task.column === "merged") continue;
				openTasks++;

				const alive = agentAlive(db, task.id);
				if (alive) {
					anyAgentAlive = true;
					continue; // live agent — the hooks own this card
				}

				// Agent is not running. First, has the branch been merged elsewhere?
				const last = lastNetCheck.get(task.id) ?? 0;
				if (Date.now() - last >= NET_THROTTLE_MS) {
					lastNetCheck.set(task.id, Date.now());
					try {
						const res = await detectMerged({
							worktreePath: task.worktreePath,
							branch: task.branch,
							baseBranch: task.baseBranch,
						});
						if (res.merged) {
							repo.updateTask(db, task.id, {
								column: "merged",
								prState: "merged",
								prNumber: res.prNumber ?? task.prNumber ?? null,
								prUrl: res.prUrl ?? task.prUrl ?? null,
								mergeStatus: null,
							});
							ctx.onTaskUpdated(task.id);
							merged++;
							continue;
						}
					} catch {
						/* offline or gh unavailable — retried next pass */
					}
				}

				// Not merged, agent dead, yet the card still says it's running:
				// the Stop hook never landed. Move it forward to ground truth.
				if (task.column === "running") {
					repo.updateTask(db, task.id, {
						agentStatus: "stopped",
						column: hasReviewableWork(task) ? "review" : "needs_attention",
						isUnread: true,
					});
					ctx.onTaskUpdated(task.id);
					unstuck++;
				}
			}
		}

		const parts: string[] = [];
		if (merged) parts.push(`${merged} merged`);
		if (unstuck) parts.push(`${unstuck} unstuck`);
		const summary =
			parts.length > 0
				? `reconciled ${parts.join(", ")} across ${openTasks} open task(s)`
				: `clean — ${openTasks} open task(s)`;

		// Tighten the cadence while any agent is working; relax when idle.
		const nextDelayMs = anyAgentAlive ? MIN_MS : MAX_MS;
		return { summary, nextDelayMs };
	}

	return {
		id: ID,
		title: "Board reconciler",
		description:
			"Realigns kanban columns with reality: detects PRs merged outside Ateam and frees cards stuck in 'running' after an agent died without reporting Stop.",
		scope: "global",
		cadence: { mode: "self_paced", minMs: MIN_MS, maxMs: MAX_MS },
		enabledByDefault: true,
		run,
	};
}
