import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

/**
 * One xterm.js view bound to a main-process PTY by terminalId. Replays the
 * ring-buffer snapshot on mount (so re-attaching shows recent scrollback),
 * streams live output, and forwards keystrokes + resize back to the PTY.
 */
export function TerminalView({ terminalId }: { terminalId: string }) {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;

		const term = new Terminal({
			fontSize: 12.5,
			fontFamily: 'ui-monospace, Menlo, "SF Mono", monospace',
			cursorBlink: true,
			theme: { background: "#000000", foreground: "#e6e6ea" },
			scrollback: 5000,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(el);
		try {
			fit.fit();
		} catch {
			/* not laid out yet */
		}

		// Focus so keystrokes (incl. Enter) reach this PTY. In Mission Control
		// many terminals are mounted; clicking a tile focuses the one you want.
		term.focus();
		const focusTerm = () => term.focus();
		el.addEventListener("mousedown", focusTerm);

		const offData = window.ateam.pty.onData((e) => {
			if (e.terminalId === terminalId) term.write(e.data);
		});

		// Replay recent output after attaching the live listener.
		void window.ateam.pty.snapshot(terminalId).then((buf) => {
			if (buf) term.write(buf);
		});

		const disposeInput = term.onData((d) =>
			window.ateam.pty.write(terminalId, d),
		);

		const syncSize = () => {
			try {
				fit.fit();
				window.ateam.pty.resize(terminalId, term.cols, term.rows);
			} catch {
				/* ignore */
			}
		};
		const ro = new ResizeObserver(syncSize);
		ro.observe(el);
		syncSize();

		return () => {
			el.removeEventListener("mousedown", focusTerm);
			offData();
			disposeInput.dispose();
			ro.disconnect();
			term.dispose();
		};
	}, [terminalId]);

	return <div className="term" ref={ref} />;
}
