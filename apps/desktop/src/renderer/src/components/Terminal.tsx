import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { FileUp, Plus } from "lucide-react";
import { useEffect, useRef } from "react";
import { Menu } from "./Menu";

/**
 * Backslash-escape a path so it survives being TYPED into a PTY. Drops and the
 * file picker type paths as keystrokes (not bracketed paste) so Claude Code's
 * "typed path → [Image #N]" detection fires — that wants shell-style escaping,
 * not quoting.
 */
const escapePath = (p: string) =>
	p.replace(/([ '"\\!$&*()[\]{};<>?#~`|])/g, "\\$1");

/**
 * One xterm.js view bound to a main-process PTY by terminalId. Replays the
 * ring-buffer snapshot on mount (so re-attaching shows recent scrollback),
 * streams live output, and forwards keystrokes + resize back to the PTY.
 * A slim toolbar underneath offers a `+` menu (e.g. attach files by path).
 */
export function TerminalView({ terminalId }: { terminalId: string }) {
	const ref = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);

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
		termRef.current = term;
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

		// Pasting an image: resolve it to a real file path and paste THAT
		// (bracketed), so the agent loads the file's bytes. Sending Ctrl+V
		// instead makes the agent do its own clipboard read, which grabs a
		// copied file's generic Finder icon rather than its contents. The menu's
		// Paste role fires a DOM `paste` event (the renderer never sees ⌘V's
		// keydown — the menu owns that accelerator), intercepted here in capture
		// phase before xterm's own textarea paste handler.
		const onPaste = (e: Event) => {
			if (!window.ateam.utils.clipboardHasImage()) return; // text → xterm
			e.preventDefault();
			e.stopPropagation();
			void window.ateam.utils.clipboardImagePath().then((p) => {
				if (p) {
					term.paste(`${escapePath(p)} `);
					term.focus();
				}
			});
		};
		el.addEventListener("paste", onPaste, true);

		// Dropping files types their backslash-escaped paths straight to the PTY,
		// exactly like a real terminal (iTerm/Terminal.app) does on a file drop.
		// This is deliberately NOT term.paste(): a paste arrives wrapped in
		// bracketed-paste markers, which Claude Code treats as a literal text
		// block and does NOT scan for a droppable file path — so the image never
		// attaches and you're left with a literal path. Typed keystrokes are what
		// trigger its "dropped path → [Image #N]" detection.
		const onDragOver = (e: DragEvent) => e.preventDefault();
		const onDrop = (e: DragEvent) => {
			e.preventDefault();
			const files = Array.from(e.dataTransfer?.files ?? []);
			if (files.length === 0) return;
			const paths = files
				.map((f) => window.ateam.utils.pathForFile(f))
				.filter(Boolean)
				.map(escapePath);
			if (paths.length) {
				window.ateam.pty.write(terminalId, `${paths.join(" ")} `);
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
		//
		// One more wrinkle: while the element is hidden (changes view open, etc.)
		// output still streams in via term.write(), but the DOM renderer can't
		// paint those rows correctly with zero layout. When we're revealed again
		// at the *same* window size, fit() is a no-op and the cols/rows guard
		// below would early-return without ever repainting — leaving the rows
		// written while hidden missing until an actual resize. So on the
		// hidden→visible transition we force a full refresh.
		let raf = 0;
		let lastCols = 0;
		let lastRows = 0;
		let wasHidden = false;
		const syncSize = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				if (el.clientWidth === 0 || el.clientHeight === 0) {
					wasHidden = true;
					return;
				}
				try {
					fit.fit();
				} catch {
					return; /* not laid out yet */
				}
				const justRevealed = wasHidden;
				wasHidden = false;
				if (term.cols === lastCols && term.rows === lastRows) {
					// Same grid: fit() didn't trigger a repaint. If we just came
					// back into view, redraw every row so content written while
					// hidden isn't left missing until the next resize.
					if (justRevealed) {
						term.refresh(0, term.rows - 1);
						term.scrollToBottom();
					}
					return;
				}
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
			termRef.current = null;
			term.dispose();
		};
	}, [terminalId]);

	// "+ → Files…": native picker, then type the escaped paths into the PTY —
	// same effect as dragging the files onto the terminal.
	const addFiles = async () => {
		const paths = (await window.ateam.utils.pickFiles()).map(escapePath);
		if (paths.length) {
			window.ateam.pty.write(terminalId, `${paths.join(" ")} `);
		}
		termRef.current?.focus();
	};

	return (
		<div className="term-shell">
			{/* .term-area is the flex-sized box; .term is absolutely positioned to
			    fill it, so the xterm canvas can never prop the layout open — the
			    available space drives the terminal size, not the other way round. */}
			<div className="term-area">
				<div className="term" ref={ref} />
			</div>
			<div className="term-toolbar">
				<Menu
					icon={Plus}
					label="Add to terminal"
					items={[{ label: "Files…", icon: FileUp, onClick: addFiles }]}
				/>
			</div>
		</div>
	);
}
