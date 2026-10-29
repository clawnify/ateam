// Archive open tasks nobody has touched in a while.
//
// The board only ever grew: a task that was never merged stayed in Needs You or
// Review forever, and so did its line in get_board and list_peers, which every
// agent on the board reads. Archiving takes such a task off every list without
// deleting anything (worktree, branch and conversation stay), and any activity
// in it brings it back (the hook handler clears `archivedAt`), so it is safe to
// do unattended.
//
// "Idle" is the last hook event, falling back to creation for a task no hook
// ever reached, or the last time it was brought back by hand if that is later.
// Never `updatedAt`: the git-status sweep and PR polling bump that on every
// task, so nothing would ever look idle.
import { type AteamDb, repo, type Task } from "@ateam/db";

const DAY_MS = 86_400_000;

/** How often the sweep runs. One read over the open rows, so hourly is cheap
 *  and keeps "N days" honest to the hour. */
export const ARCHIVE_SWEEP_MS = 60 * 60 * 1000;

export interface ArchiveDeps {
	db: AteamDb;
	/** Whether any of the task's terminals is still up. */
	isLive: (taskId: string) => boolean;
}

/**
 * Whether `task` should be archived at `now`. Kept out: merged tasks (Done is
 * not this sweep's business), a task with a live terminal, a task parked on a
 * wait that has not come due, and a loop's task, which sits idle between ticks
 * by design.
 */
export function isArchivable(
	task: Task,
	now: number,
	afterDays: number,
	exempt: { live: boolean; loopOwned: boolean },
): boolean {
	if (afterDays <= 0 || task.archivedAt != null) return false;
	if (task.column === "merged") return false;
	if (exempt.live || exempt.loopOwned) return false;
	if (task.waitingUntil != null && task.waitingFiredAt == null) return false;
	const idleSince = Math.max(task.lastEventAt ?? task.createdAt ?? 0, task.restoredAt ?? 0);
	return now - idleSince >= afterDays * DAY_MS;
}

/** One pass over every project. Returns the ids it archived, so the caller can
 *  take the cards off every client. */
export function archiveIdleTasks(deps: ArchiveDeps, afterDays: number, now = Date.now()): string[] {
	const { db, isLive } = deps;
	if (afterDays <= 0) return [];
	const loopTasks = new Set<string>();
	for (const loop of repo.listLoops(db)) {
		for (const id of [loop.config?.taskId, loop.config?.lastTaskId]) {
			if (typeof id === "string") loopTasks.add(id);
		}
	}
	const archived: string[] = [];
	for (const project of repo.listProjects(db)) {
		for (const task of repo.listTasks(db, project.id)) {
			const exempt = { live: isLive(task.id), loopOwned: loopTasks.has(task.id) };
			if (!isArchivable(task, now, afterDays, exempt)) continue;
			repo.updateTask(db, task.id, { archivedAt: now });
			archived.push(task.id);
		}
	}
	return archived;
}
