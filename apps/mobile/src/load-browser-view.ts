import type { AteamApi } from "@ateam/protocol";

// BoxBrowser's view comes from asking the box, and the box can miss for a while
// with nothing lasting wrong. Just after a Sprite woke, both asks it used to get
// missed, and the view stayed hidden until the terminal reopened. So this keeps
// asking until the box answers. A task only asks once its agent has called the
// browser's tools (TaskDTO.browserUsedAt), and every engine that marks a task also
// answers the call (both arrived in v17), so a miss is nearly always a slow box.
// Where one lasts (a box with no browser), the view stays hidden as it always did,
// for one cheap ask every 30s while the terminal is open.

/** Waits between asks; the last one repeats until the box answers. */
export const VIEW_RETRY_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000];

/** Ask until the view comes back, then hand over its URL. Returns a stop, for an unmount. */
export function loadBrowserView(
	api: AteamApi,
	taskId: string,
	onUrl: (url: string) => void,
	retryMs: readonly number[] = VIEW_RETRY_MS,
): () => void {
	let live = true;
	let misses = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const ask = () =>
		api.browser.view(taskId).then(
			(r) => live && onUrl(r.url),
			(err) => {
				if (!live) return;
				// Once per outage, not per attempt: a box that stays down would
				// otherwise warn every 30s for as long as its terminal is open.
				if (misses === 0) console.warn("[BoxBrowser] browser.view failed, retrying:", err);
				timer = setTimeout(ask, retryMs[Math.min(misses, retryMs.length - 1)]);
				misses++;
			},
		);
	ask();
	return () => {
		live = false;
		clearTimeout(timer);
	};
}
