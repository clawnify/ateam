// Who gets to size a PTY when several viewers show the same terminal.
//
// A PTY has exactly one size, but one task is routinely open in more than one
// place at once: the desktop and the phone on a box, two desktop windows, an
// `ateam attach` shell. Every viewer fits its xterm to its own viewport and
// reports that size, and until now each report was applied verbatim — last
// writer wins. A phone that merely OPENS the task (or shows its keyboard) then
// shrinks the desktop's terminal to phone dimensions, and the desktop never
// recovers because it only re-reports when its own grid changes.
//
// This is tmux's problem, and tmux's answer (`window-size latest`) is the one
// used here: the PTY follows the viewer the user is actually USING. A viewer
// owns the size from the moment it claims it — by being the first to report a
// size, or by sending input — and keeps it until another viewer sends input or
// the owner goes away. Everyone else's size reports are remembered, not applied,
// so that when a viewer takes over by typing its last-known size is applied at
// once, even though it has nothing new to report.
//
// Pure policy, no I/O: the dispatcher asks it what to apply and calls the PTY.

export interface TermSize {
	cols: number;
	rows: number;
}

interface TerminalSizing {
	/** The viewer whose size the PTY follows; null until anyone reports one. */
	owner: string | null;
	/** Each viewer's last reported size, applied or not. */
	sizes: Map<string, TermSize>;
	/** What the PTY was last told, so a takeover with the same size is a no-op. */
	applied: TermSize | null;
}

export interface SizeArbiter {
	/**
	 * A viewer reported its size. Returns the size to apply to the PTY, or null
	 * when this viewer is not the owner (the report is remembered for later).
	 */
	resize(terminalId: string, client: string, size: TermSize): TermSize | null;
	/**
	 * A viewer sent input: it becomes the owner. Returns its remembered size if
	 * the PTY is not already at it, else null.
	 */
	activity(terminalId: string, client: string): TermSize | null;
	/** A viewer disconnected: forget its sizes and release any terminal it owned. */
	dropClient(client: string): void;
	/** A terminal is gone: forget everything about it. */
	forget(terminalId: string): void;
}

const same = (a: TermSize | null, b: TermSize): boolean =>
	a !== null && a.cols === b.cols && a.rows === b.rows;

export function createSizeArbiter(): SizeArbiter {
	const terminals = new Map<string, TerminalSizing>();
	const get = (terminalId: string): TerminalSizing => {
		let t = terminals.get(terminalId);
		if (!t) {
			t = { owner: null, sizes: new Map(), applied: null };
			terminals.set(terminalId, t);
		}
		return t;
	};

	return {
		resize(terminalId, client, size) {
			const t = get(terminalId);
			t.sizes.set(client, size);
			// The first viewer to report holds the size until someone else acts:
			// a second viewer that just opens the terminal must not resize it.
			if (t.owner === null) t.owner = client;
			if (t.owner !== client || same(t.applied, size)) return null;
			t.applied = size;
			return size;
		},
		activity(terminalId, client) {
			const t = get(terminalId);
			t.owner = client;
			const size = t.sizes.get(client);
			if (!size || same(t.applied, size)) return null;
			t.applied = size;
			return size;
		},
		dropClient(client) {
			for (const t of terminals.values()) {
				t.sizes.delete(client);
				// Nobody inherits: the PTY keeps its size until the next viewer acts,
				// and that viewer's first report (or keystroke) takes it over.
				if (t.owner === client) t.owner = null;
			}
		},
		forget(terminalId) {
			terminals.delete(terminalId);
		},
	};
}
