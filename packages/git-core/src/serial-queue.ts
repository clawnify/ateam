/**
 * A FIFO queue that runs at most ONE task per key at a time. Tasks under
 * different keys run concurrently; tasks sharing a key run strictly in enqueue
 * order, each awaiting the previous one's *settle* (resolve OR reject) so a
 * failing job never stalls or breaks the chain behind it.
 *
 * Pure and git-agnostic on purpose: the merge queue composes this with git
 * operations, but the serialization logic carries no domain knowledge and is
 * unit-tested on its own. Key the merge queue by `${repoPath}::${baseBranch}`
 * so two branches targeting the same base merge one-at-a-time, while unrelated
 * bases stay parallel.
 */
export class SerialQueue {
	/** Per-key promise of the last enqueued task's settle (swallowed). */
	private readonly tails = new Map<string, Promise<void>>();
	/** Per-key count of tasks queued-or-running, including the active one. */
	private readonly depths = new Map<string, number>();

	/** Tasks queued or running under `key` (0 when idle). */
	depth(key: string): number {
		return this.depths.get(key) ?? 0;
	}

	/** True when at least one task is queued or running under `key`. */
	busy(key: string): boolean {
		return this.depth(key) > 0;
	}

	/**
	 * Enqueue `fn` under `key`. The returned promise settles with `fn`'s result
	 * (or rejection). `onStart`, if given, fires the moment this task leaves the
	 * queue and begins running — i.e. after every earlier task for `key` has
	 * settled — which is the right hook for flipping a "queued" badge to
	 * "running".
	 */
	enqueue<T>(key: string, fn: () => Promise<T>, onStart?: () => void): Promise<T> {
		const prev = this.tails.get(key) ?? Promise.resolve();
		this.depths.set(key, this.depth(key) + 1);

		const result = (async () => {
			// A prior task's failure must not propagate into this one.
			await prev.catch(() => {});
			onStart?.();
			return fn();
		})();

		// The tail tracks *settle* only, so the chain advances on success or
		// failure alike; outcomes are swallowed here and surfaced via `result`.
		const tail = result.then(
			() => {},
			() => {},
		);
		this.tails.set(key, tail);

		void tail.then(() => {
			const remaining = this.depth(key) - 1;
			if (remaining > 0) {
				this.depths.set(key, remaining);
				return;
			}
			this.depths.delete(key);
			// Only drop the tail if no later enqueue has since replaced it.
			if (this.tails.get(key) === tail) this.tails.delete(key);
		});

		return result;
	}
}
