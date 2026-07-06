import type { AteamDb, MergeStatus, Task } from "@ateam/db";
import { repo } from "@ateam/db";
import { type MergeStrategy, mergeViaPR, SerialQueue, updateFromBase } from "@ateam/git-core";

export interface MergeJobInput {
	task: Task;
	repoPath: string;
	strategy: MergeStrategy;
	/** How to absorb the (possibly just-merged) base before merging. */
	updateStrategy: "merge" | "rebase";
	deleteRemoteBranch: boolean;
}

export type MergeJobResult =
	| { ok: true; prNumber: number | null; prUrl: string | null }
	| { ok: false; reason: "conflict"; conflicts: string[] }
	| { ok: false; reason: "busy" }
	| { ok: false; reason: "error"; message: string };

export interface MergeQueueDeps {
	db: AteamDb;
	/** Notify the renderer a task row changed (column/mergeStatus/pr fields). */
	onTaskUpdated: (taskId: string) => void;
}

/**
 * Serializes merges so two task branches targeting the SAME base never race.
 * Without this, both `gh pr merge` at once — whoever wins moves the base, and
 * the loser hits a diverged base or hands the agent a conflict. Here they queue
 * by `${repoPath}::${baseBranch}`: each job absorbs the freshly-merged base
 * (auto-update-then-retry) before merging, so the second branch only ever stops
 * on a *genuine* code conflict. Branches targeting different bases stay parallel.
 *
 * Intake is unified: the in-app Merge button (IPC) and an agent's terminal
 * `gh pr merge` (routed in via the gh shim → hook server) both call `enqueue`.
 */
export class MergeQueue {
	private readonly queue = new SerialQueue();

	constructor(private readonly deps: MergeQueueDeps) {}

	private key(repoPath: string, baseBranch: string): string {
		return `${repoPath}::${baseBranch}`;
	}

	/** Tasks queued or merging against this base (0 when idle). */
	depth(repoPath: string, baseBranch: string): number {
		return this.queue.depth(this.key(repoPath, baseBranch));
	}

	/**
	 * Enqueue a merge. Returns once this task's merge settles. The task is marked
	 * `queued` synchronously (visible on the board immediately), then flips to
	 * `updating`/`merging` as it leaves the queue. A task already in flight is
	 * not re-enqueued.
	 */
	enqueue(input: MergeJobInput): Promise<MergeJobResult> {
		const { task } = input;
		const fresh = repo.getTask(this.deps.db, task.id);
		if (fresh?.mergeStatus) {
			// Already queued/updating/merging — double-click or shim+UI overlap.
			return Promise.resolve({ ok: false, reason: "busy" });
		}
		this.setStatus(task.id, "queued");
		return this.queue.enqueue(this.key(input.repoPath, task.baseBranch), () => this.runJob(input));
	}

	private async runJob(input: MergeJobInput): Promise<MergeJobResult> {
		const { task, db } = { task: input.task, db: this.deps.db };
		try {
			// Absorb the base first. If an earlier queued merge just advanced it,
			// this is where that lands; if the base is unchanged it's a clean no-op.
			this.setStatus(task.id, "updating");
			const upd = await updateFromBase({
				worktreePath: task.worktreePath,
				baseBranch: task.baseBranch,
				strategy: input.updateStrategy,
			});
			if (upd.status === "conflicts") {
				// A real code conflict — leave the in-progress merge/rebase in the
				// worktree for resolution and surface it on the board.
				repo.updateTask(db, task.id, {
					mergeStatus: "conflict",
					column: "needs_attention",
					isUnread: true,
				});
				this.deps.onTaskUpdated(task.id);
				return { ok: false, reason: "conflict", conflicts: upd.conflicts };
			}

			this.setStatus(task.id, "merging");
			const res = await mergeViaPR({
				repoPath: input.repoPath,
				worktreePath: task.worktreePath,
				branch: task.branch,
				baseBranch: task.baseBranch,
				strategy: input.strategy,
				deleteRemoteBranch: input.deleteRemoteBranch,
			});
			repo.updateTask(db, task.id, {
				column: "merged",
				prNumber: res.prNumber ?? null,
				prUrl: res.prUrl ?? null,
				prState: "merged",
				mergeStatus: null,
			});
			this.deps.onTaskUpdated(task.id);
			return { ok: true, prNumber: res.prNumber, prUrl: res.prUrl };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// Clear the badge; the task stays where it was so it can be retried.
			repo.updateTask(db, task.id, { mergeStatus: null });
			this.deps.onTaskUpdated(task.id);
			return { ok: false, reason: "error", message };
		}
	}

	private setStatus(taskId: string, mergeStatus: MergeStatus | null): void {
		repo.updateTask(this.deps.db, taskId, { mergeStatus });
		this.deps.onTaskUpdated(taskId);
	}
}
