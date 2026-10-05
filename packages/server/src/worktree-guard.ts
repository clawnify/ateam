// Keeps every writer out of a task's worktree while that worktree is being
// deleted.
//
// Deleting a task kills its sessions and then runs `git worktree remove`. The
// kill is itself what brings a writer back: an open task panel sees its agent
// exit and auto-resumes it (`claude --continue`), and that launch writes
// `.claude/settings.local.json` into the worktree and spawns a PTY there while
// git is unlinking it. git's last rmdir then fails with "Directory not empty",
// the task row survives, and the resumed agent keeps running in a directory
// that no task owns. Seeding is the other writer: its final rename lands
// `node_modules` into the worktree, recreating the directory if it was already
// gone.
//
// So a removal is: mark (new launches refuse) → abort the seed → drain the
// launches already under way → delete. Process memory, not a column: a removal
// only exists for as long as the call making it, and a crash mid-removal must
// leave a task that can simply be deleted again.
import { TASK_REMOVING_ERROR } from "@ateam/protocol";

export class WorktreeGuard {
	/** Removals in flight per task: a count, since a double click starts two. */
	private readonly removing = new Map<string, number>();
	private readonly launches = new Map<string, Set<Promise<unknown>>>();
	private readonly seeds = new Map<string, AbortController>();

	/** Throw if the task's worktree is being deleted. Call before writing into it. */
	assertWritable(taskId: string): void {
		if (this.removing.has(taskId)) throw new Error(TASK_REMOVING_ERROR);
	}

	/** Run a launch so a removal that starts meanwhile waits for it to settle. */
	async launch<T>(taskId: string, run: () => Promise<T>): Promise<T> {
		this.assertWritable(taskId);
		const pending = run();
		let set = this.launches.get(taskId);
		if (!set) {
			set = new Set();
			this.launches.set(taskId, set);
		}
		set.add(pending);
		try {
			return await pending;
		} finally {
			set.delete(pending);
			if (set.size === 0) this.launches.delete(taskId);
		}
	}

	/** The signal a task's seed watches; a removal aborts it. */
	seedSignal(taskId: string): AbortSignal {
		const controller = new AbortController();
		this.seeds.set(taskId, controller);
		return controller.signal;
	}

	seedDone(taskId: string): void {
		this.seeds.delete(taskId);
	}

	/**
	 * Delete a task's worktree with nothing else writing into it. `seed` is the
	 * task's in-flight seed, if any (`services.pendingSeeds`): aborted first, so
	 * waiting for it costs the moment its current copy is killed, not a minute.
	 */
	async remove<T>(
		taskId: string,
		seed: Promise<void> | undefined,
		run: () => Promise<T>,
	): Promise<T> {
		this.removing.set(taskId, (this.removing.get(taskId) ?? 0) + 1);
		try {
			this.seeds.get(taskId)?.abort();
			await Promise.allSettled([...(this.launches.get(taskId) ?? []), seed]);
			return await run();
		} finally {
			const left = (this.removing.get(taskId) ?? 1) - 1;
			if (left > 0) this.removing.set(taskId, left);
			else this.removing.delete(taskId);
		}
	}
}
