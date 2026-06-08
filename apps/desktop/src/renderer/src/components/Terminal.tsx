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

		// Cmd+V with an image-only clipboard: agents read images from the
		// clipboard on Ctrl+V — forward that instead of pasting (empty) text.
		// The default app menu owns the Cmd+V key equivalent natively, so the
		// renderer never sees the keydown; the menu's paste role dispatches a
		// DOM `paste` event instead. Intercept that (capture phase, before
		// xterm's own paste handler on the textarea).
		const onPaste = (e: Event) => {
			if (!window.ateam.utils.clipboardHasImage()) return;
			e.preventDefault();
			e.stopPropagation();
			window.ateam.pty.write(terminalId, "\x16");
		};
		el.addEventListener("paste", onPaste, true);

		// Dropping files pastes their paths, like iTerm: backslash-escaped and
		// delivered via term.paste() so apps with bracketed paste on (Claude
		// Code) see a *paste* of a file path — that's what makes them attach a
		// dropped image as [Image #N] instead of leaving a literal path.
		const onDragOver = (e: DragEvent) => e.preventDefault();
		const onDrop = (e: DragEvent) => {
			e.preventDefault();
			const files = Array.from(e.dataTransfer?.files ?? []);
			if (files.length === 0) return;
			const paths = files
				.map((f) => window.ateam.utils.pathForFile(f))
				.filter(Boolean)
				.map((p) => p.replace(/([ '"\\!$&*()[\]{};<>?#~`|])/g, "\\$1"));
			if (paths.length) {
				term.paste(`${paths.join(" ")} `);
				term.focus();
			}
		};
		el.addEventListener("dragover", onDragOver);
		el.addEventListener("drop", onDrop);

		// Forward app-level focus to the terminal: macOS app switches don't
		// change DOM focus, so without this an agent that asked for focus
		// reporting (mode 1004) never hears you came back — Claude Code uses
		// that to re-check the clipboard for its "Image in clipboard" hint.
		// xterm only emits CSI I/O if the app enabled 1004, so this is inert
		// for everything else. Guarded so only the focused tile re-focuses
		// (Mission Control mounts many terminals).
		let hadFocus = false;
		const onWinBlur = () => {
			hadFocus = document.activeElement === term.textarea;
			if (hadFocus) term.textarea?.blur();
		};
		const onWinFocus = () => {
			if (hadFocus) term.focus();
		};
		window.addEventListener("blur", onWinBlur);
		window.addEventListener("focus", onWinFocus);

		// The task panel asks us to take focus after layout toggles, so Enter
		// reaches the agent instead of re-triggering the clicked button.
		const onFocusRequest = () => term.focus();
		window.addEventListener("ateam:focus-terminal", onFocusRequest);

		const offData = window.ateam.pty.onData((e) => {
			if (e.terminalId === terminalId) term.write(e.data);
		});

		// Replay recent output after attaching the live listener.
		void window.ateam.pty.snapshot(terminalId).then((buf) => {
			if (buf) term.write(buf, () => term.scrollToBottom());
		});

		const disposeInput = term.onData((d) =>
			window.ateam.pty.write(terminalId, d),
		);

		// Resize handling. Layout toggles fire several ResizeObserver callbacks
		// in quick succession (sometimes while the element is mid-layout at zero
		// size); each PTY resize SIGWINCHes the TUI agent, and a storm of them —
		// or one bogus zero-size fit — can leave it painted blank until the next
		// resize. So: coalesce to one fit per frame, never fit a hidden element,
		// and only notify the PTY when the grid actually changed.
		let raf = 0;
		let lastCols = 0;
		let lastRows = 0;
		const syncSize = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				if (el.clientWidth === 0 || el.clientHeight === 0) return;
				try {
					fit.fit();
				} catch {
					return; /* not laid out yet */
				}
				if (term.cols === lastCols && term.rows === lastRows) return;
				lastCols = term.cols;
				lastRows = term.rows;
				window.ateam.pty.resize(terminalId, term.cols, term.rows);
				term.scrollToBottom();
			});
		};
		const ro = new ResizeObserver(syncSize);
		ro.observe(el);
		syncSize();

		return () => {
			cancelAnimationFrame(raf);
			el.removeEventListener("mousedown", focusTerm);
			el.removeEventListener("dragover", onDragOver);
			el.removeEventListener("drop", onDrop);
			el.removeEventListener("paste", onPaste, true);
			window.removeEventListener("blur", onWinBlur);
			window.removeEventListener("focus", onWinFocus);
			window.removeEventListener("ateam:focus-terminal", onFocusRequest);
			offData();
			disposeInput.dispose();
			ro.disconnect();
			term.dispose();
		};
	}, [terminalId]);

	return <div className="term" ref={ref} />;
}
