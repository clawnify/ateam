// Paces a PTY's resizes so the program inside sees every size it is drawn at.
//
// A program learns its size from SIGWINCH, and acts only when the size it then
// reads differs from the last one it read (Node's tty emits `resize` only on a
// change, and so does the Bun copy of it that Claude Code runs on). So two
// resizes that both land before it reads, ending at the size it already had,
// never reach it: it does not repaint. That happens when a tile shrinks and
// grows straight back while the agent is busy mid-turn: the two resizes leave
// the renderer a frame apart, but a busy engine or daemon can queue them, and
// then they reach the PTY back to back.
//
// Every xterm on the way still applied both, and shrinking an xterm drops the
// rows below its cursor, so a full-screen agent such as Claude Code is left
// with its input box and footer blank until the next real resize. Reproduced
// with Claude Code 2.1.318 through the daemon (2026-11-04): during a streaming
// turn, 24 of 40 such pairs got no repaint.
//
// tmux solved this (server_client_check_pane_resize in server-client.c) and its
// policy is used here. A resize goes through at once. Later ones wait out a
// short gap, then only the newest is applied. A batch that ends at the size the
// PTY already has is applied as its last-but-one size and then, a gap later,
// the last, so the program is made to redraw at its real size.
//
// Pure policy, no I/O: the daemon supplies the function that resizes the PTY.

export interface PtySize {
	cols: number;
	rows: number;
}

/**
 * The least time between two resizes of one PTY. The program has this long to
 * read the first size before the second lands. tmux waits 250ms between batches
 * (10ms inside a forced pair). Ceiling: a program stalled for longer than this
 * can still miss a forced pair; raise it if an agent is seen doing that.
 */
export const RESIZE_GAP_MS = 100;

export interface ResizePacer {
	/** The size this PTY should have. Applied now, or after the gap. */
	request(size: PtySize): void;
	/** The PTY is gone: drop what is queued and stop the timer. */
	dispose(): void;
}

export interface PacerTimers {
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const nodeTimers: PacerTimers = {
	set: (fn, ms) => setTimeout(fn, ms),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const same = (a: PtySize, b: PtySize): boolean => a.cols === b.cols && a.rows === b.rows;

export function createResizePacer(
	initial: PtySize,
	apply: (size: PtySize) => void,
	gapMs: number = RESIZE_GAP_MS,
	timers: PacerTimers = nodeTimers,
): ResizePacer {
	// What the PTY was last told, and the sizes asked for since, oldest first.
	let applied: PtySize = { ...initial };
	let queue: PtySize[] = [];
	let timer: unknown = null;

	const flush = (): void => {
		const last = queue.at(-1);
		if (!last) return;
		let next = last;
		if (queue.length > 1 && same(last, applied)) {
			// Back where it started: the program would see no change at all.
			// The size before the last is never the last (see request).
			next = queue[queue.length - 2] as PtySize;
			queue = [last];
		} else {
			queue = [];
		}
		applied = next;
		apply(next);
		timer = timers.set(() => {
			timer = null;
			flush();
		}, gapMs);
	};

	return {
		request(size) {
			if (same(queue.at(-1) ?? applied, size)) return;
			queue.push({ cols: size.cols, rows: size.rows });
			if (timer === null) flush();
		},
		dispose() {
			if (timer !== null) timers.clear(timer);
			timer = null;
			queue = [];
		},
	};
}
