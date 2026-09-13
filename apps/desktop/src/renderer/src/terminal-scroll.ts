import type { Terminal } from "@xterm/xterm";

/** Keep output at the bottom across xterm's asynchronous viewport updates. */
export function terminalScroll(term: Terminal, host: HTMLElement) {
	let pending = false;
	let frame = 0;
	let generation = 0;
	let disposed = false;

	const cancel = () => {
		generation++;
		pending = false;
		cancelAnimationFrame(frame);
	};
	// A queued correction must never override a user starting to read scrollback.
	const inputs = ["wheel", "pointerdown", "touchstart", "keydown"] as const;
	for (const input of inputs) host.addEventListener(input, cancel, true);

	return {
		get following() {
			return pending || term.buffer.active.viewportY === term.buffer.active.baseY;
		},
		bottom() {
			if (disposed || pending) return;
			pending = true;
			const current = generation;
			term.write("", () => {
				if (disposed || current !== generation) return;
				// Clearing scrollback shrinks xterm 5's DOM scroll area on the next
				// frame. Its resulting native scroll event can then reset viewportY
				// after a write callback already scrolled down. Let that event land
				// before restoring the bottom on the following frame.
				frame = requestAnimationFrame(() => {
					frame = requestAnimationFrame(() => {
						pending = false;
						// After hidden output, the buffer can already be at bottom
						// while the DOM scrollbar is stale. A one-row round trip
						// forces xterm to sync it; both moves happen before paint.
						if (term.buffer.active.viewportY === term.buffer.active.baseY) {
							term.scrollLines(-1);
						}
						term.scrollToBottom();
					});
				});
			});
		},
		dispose() {
			disposed = true;
			cancel();
			for (const input of inputs) host.removeEventListener(input, cancel, true);
		},
	};
}
