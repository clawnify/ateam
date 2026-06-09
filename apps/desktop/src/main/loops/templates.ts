import type { Project } from "@ateam/db";
import { repo } from "@ateam/db";
import { type MergeStrategy, prStatus } from "@ateam/git-core";
import type { LoopCadence, LoopContext, LoopOutcome } from "./types";

/** A configurable parameter a user sets when creating a loop from a template. */
export interface LoopTemplateParam {
	key: string;
	label: string;
	type: "number" | "boolean";
	default: number | boolean;
	help?: string;
}

/**
 * A code-side recipe a user instantiates into a concrete loop. The instance's
 * name, project scope, cadence, and param values are persisted in the `loops`
 * table; `build` turns the stored config into the actual run function.
 */
export interface LoopTemplate {
	id: string;
	title: string;
	description: string;
	defaultCadence: LoopCadence;
	params: LoopTemplateParam[];
	build(config: Record<string, unknown>): (ctx: LoopContext) => Promise<LoopOutcome>;
}

/** Projects in scope: just the configured one, or all when unscoped. */
function scopedProjects(ctx: LoopContext, projectId?: string): Project[] {
	if (projectId) {
		const p = repo.getProject(ctx.db, projectId);
		return p ? [p] : [];
	}
	return repo.listProjects(ctx.db);
}

const MIN = 30_000;
const MAX = 300_000;

/**
 * PR CI watcher — read-only. For every task with an open PR, read the check
 * rollup; when checks fail, flag the card unread so you notice. Touches no
 * worktree and never moves a card on its own.
 */
const prCiWatcher: LoopTemplate = {
	id: "pr-ci-watcher",
	title: "PR CI watcher",
	description:
		"Watches open PRs and flags a task as unread when its CI checks fail. Read-only — never moves a card.",
	defaultCadence: { mode: "self_paced", minMs: MIN, maxMs: MAX },
	params: [],
	build: (config) => async (ctx) => {
		const projectId = config.projectId as string | undefined;
		let failing = 0;
		let pending = 0;
		let checked = 0;
		for (const project of scopedProjects(ctx, projectId)) {
			for (const task of repo.listTasks(ctx.db, project.id)) {
				if (task.column === "merged" || task.prNumber == null) continue;
				checked++;
				const status = await prStatus(task.worktreePath);
				if (status.state !== "OPEN") continue;
				if (status.checks === "pending") pending++;
				if (status.checks === "failing") {
					failing++;
					if (!task.isUnread) {
						repo.updateTask(ctx.db, task.id, { isUnread: true });
						ctx.onTaskUpdated(task.id);
					}
				}
			}
		}
		return {
			summary: `${checked} PR(s): ${failing} failing, ${pending} pending`,
			// Check often while something is in flight; relax when all settled.
			nextDelayMs: pending > 0 ? MIN : MAX,
		};
	},
};

/**
 * Auto-merge when green — an ACTION template. For tasks in review with an open,
 * mergeable PR whose checks all pass, it enqueues a merge through the same
 * serialized merge queue (so these never race with manual merges either).
 * Only merges what the user explicitly put in review.
 */
const autoMergeWhenGreen: LoopTemplate = {
	id: "auto-merge-when-green",
	title: "Auto-merge when green",
	description:
		"Merges review-column tasks whose PR is mergeable and all checks pass, via the merge queue. Only acts on cards you've moved to Review.",
	defaultCadence: { mode: "self_paced", minMs: MIN, maxMs: MAX },
	params: [],
	build: (config) => async (ctx) => {
		const projectId = config.projectId as string | undefined;
		const settings = repo.getSettings(ctx.db);
		let merged = 0;
		let waiting = 0;
		let eligible = 0;
		for (const project of scopedProjects(ctx, projectId)) {
			for (const task of repo.listTasks(ctx.db, project.id)) {
				if (task.column !== "review" || task.prNumber == null) continue;
				if (task.mergeStatus) continue; // already queued/merging
				eligible++;
				const status = await prStatus(task.worktreePath);
				if (status.state !== "OPEN") continue;
				if (status.checks === "pending") {
					waiting++;
					continue;
				}
				if (status.checks !== "passing" || status.mergeable !== "MERGEABLE") {
					continue;
				}
				ctx.mergeQueue?.enqueue({
					task,
					repoPath: project.repoPath,
					strategy: (settings.defaultMergeStrategy ?? "squash") as MergeStrategy,
					updateStrategy: settings.defaultUpdateStrategy ?? "merge",
					deleteRemoteBranch: settings.deleteRemoteBranchOnMerge ?? false,
				});
				merged++;
			}
		}
		return {
			summary: `${eligible} in review: ${merged} merging, ${waiting} awaiting CI`,
			nextDelayMs: waiting > 0 || merged > 0 ? MIN : MAX,
		};
	},
};

export const LOOP_TEMPLATES: LoopTemplate[] = [prCiWatcher, autoMergeWhenGreen];

export function getTemplate(id: string): LoopTemplate | undefined {
	return LOOP_TEMPLATES.find((t) => t.id === id);
}
