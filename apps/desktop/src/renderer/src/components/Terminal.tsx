import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { FileUp, Plus } from "lucide-react";
import { useEffect, useRef } from "react";
import { Menu } from "./Menu";

/** Shell-quote a path so spaces and quotes survive being typed into a PTY. */
const quotePath = (p: string) =>
	/[\s'"\\]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p;

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

		// Cmd+V with an image-only clipboard: agents read images from the
		// clipboard on Ctrl+V — forward that instead of pasting (empty) text.
		term.attachCustomKeyEventHandler((ev) => {
			if (
				ev.type === "keydown" &&
				ev.metaKey &&
				!ev.ctrlKey &&
				ev.key.toLowerCase() === "v" &&
				window.ateam.utils.clipboardHasImage()
			) {
				window.ateam.pty.write(terminalId, "\x16");
				return false;
			}
			return true;
		});

		// Dropping files types their (quoted) paths, like iTerm — so you can
		// drag an image straight into an agent conversation.
		const onDragOver = (e: DragEvent) => e.preventDefault();
		const onDrop = (e: DragEvent) => {
			e.preventDefault();
			const files = Array.from(e.dataTransfer?.files ?? []);
			if (files.length === 0) return;
			const paths = files
				.map((f) => window.ateam.utils.pathForFile(f))
				.filter(Boolean)
				.map(quotePath);
			if (paths.length) {
				window.ateam.pty.write(terminalId, `${paths.join(" ")} `);
				term.focus();
			}
		};
		el.addEventListener("dragover", onDragOver);
		el.addEventListener("drop", onDrop);

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
			window.removeEventListener("ateam:focus-terminal", onFocusRequest);
			offData();
			disposeInput.dispose();
			ro.disconnect();
			termRef.current = null;
			term.dispose();
		};
	}, [terminalId]);

	// "+ → Files…": native picker, then type the quoted paths into the PTY —
	// same effect as dragging the files onto the terminal.
	const addFiles = async () => {
		const paths = (await window.ateam.utils.pickFiles()).map(quotePath);
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
