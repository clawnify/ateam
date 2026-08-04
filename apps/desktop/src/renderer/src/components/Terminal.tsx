import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import { ChevronDown, ChevronUp, FileUp, ImageUp, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Menu } from "./Menu";

/**
 * Highlight styles for ⌘F matches. Decorations only tint the background —
 * the light-gray foreground stays as-is — so both colors are dark enough to
 * keep the text readable: slate for matches, amber for the active one.
 */
const SEARCH_DECORATIONS = {
	matchBackground: "#3a3f4a",
	activeMatchBackground: "#6b5900",
	matchOverviewRuler: "#6b7280",
	activeMatchColorOverviewRuler: "#fbbf24",
};

/**
 * Backslash-escape a path so it survives being TYPED into a PTY. Drops and the
 * file picker type paths as keystrokes (not bracketed paste) so Claude Code's
 * "typed path → [Image #N]" detection fires — that wants shell-style escaping,
 * not quoting.
 */
const escapePath = (p: string) => p.replace(/([ '"\\!$&*()[\]{};<>?#~`|])/g, "\\$1");

/** Paths we attach as a staged bitmap rather than a typed path. */
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif|ico)$/i;

/**
 * One xterm.js view bound to a main-process PTY by terminalId. Replays the
 * ring-buffer snapshot on mount (so re-attaching shows recent scrollback),
 * streams live output, and forwards keystrokes + resize back to the PTY.
 * A slim toolbar underneath offers a `+` menu (e.g. attach files by path).
 */
export function TerminalView({
	terminalId,
	showDone,
	onDone,
}: {
	terminalId: string;
	/** Show a "Done" action in the toolbar (e.g. task is in Review). */
	showDone?: boolean;
	/** Called when Done is clicked — the parent owns the status change. */
	onDone?: () => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);

	// ⌘F search over this terminal's scrollback (xterm SearchAddon).
	const searchRef = useRef<SearchAddon | null>(null);
	const searchInputRef = useRef<HTMLInputElement>(null);
	const [searchOpen, setSearchOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<{ index: number; count: number } | null>(null);

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
		const search = new SearchAddon();
		term.loadAddon(search);
		searchRef.current = search;
		const offResults = search.onDidChangeResults((e) =>
			setResults({ index: e.resultIndex, count: e.resultCount }),
		);
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

		// Type dropped files' backslash-escaped paths straight to the PTY, exactly
		// like a real terminal (iTerm/Terminal.app) does on a file drop.
		//
		// This is deliberately NOT term.paste(): a paste arrives wrapped in
		// bracketed-paste markers, which Claude Code treats as a literal text block
		// and does NOT scan for a droppable file path — so the image never attaches
		// and you're left with a literal path. Typed keystrokes are what trigger its
		// "path → [Image #N]" detection.
		const typeFilePaths = (files: File[]) => {
			const paths = files
				.map((f) => window.ateam.utils.pathForFile(f))
				.filter(Boolean)
				.map(escapePath);
			if (paths.length) {
				window.ateam.pty.write(terminalId, `${paths.join(" ")} `);
				term.focus();
			}
		};

		// Bring copied/dropped file(s) into the terminal. A single image file is
		// attached by staging its real bitmap on the clipboard + Ctrl+V — the only
		// reliable path: a bare Ctrl+V grabs a Finder file's generic icon, and a
		// typed path only attaches when the agent runs typed-path detection (else it
		// just leaves a literal path). Anything else (non-image, or multiple files)
		// types the escaped path(s); so does an image we couldn't decode.
		const attachFiles = (files: File[]) => {
			const paths = files.map((f) => window.ateam.utils.pathForFile(f)).filter(Boolean);
			const [only] = paths;
			if (paths.length === 1 && only && IMAGE_RE.test(only)) {
				void window.ateam.utils.stageImagePath(only).then((staged) => {
					if (staged) {
						window.ateam.pty.write(terminalId, "\x16");
						term.focus();
					} else {
						typeFilePaths(files);
					}
				});
				return;
			}
			typeFilePaths(files);
		};

		// Pasting an image. The menu's Paste role fires a DOM `paste` event with a
		// populated clipboardData (the renderer never sees ⌘V's keydown — the menu
		// owns that accelerator), intercepted here in capture phase before xterm's
		// own textarea handler. We classify straight off the event — no IPC.
		//
		// Plain text pastes normally. A non-text payload splits two ways:
		//   - a copied file (Finder) has a real path → attachFiles (a single image
		//     is staged as a bitmap + Ctrl+V; other files type their path).
		//   - a raw bitmap (screenshot) has no path → forward a bare Ctrl+V and let
		//     the agent read the bitmap off the clipboard itself, like a raw
		//     terminal. The agent renders its own "[Image #N]".
		const onPaste = (e: ClipboardEvent) => {
			const dt = e.clipboardData;
			if (!dt || dt.getData("text/plain")) return; // text → xterm
			if (dt.files.length === 0) return; // nothing image/file-like
			e.preventDefault();
			e.stopPropagation();
			const files = Array.from(dt.files);
			if (files.every((f) => window.ateam.utils.pathForFile(f))) {
				attachFiles(files); // copied file(s) on disk
			} else {
				window.ateam.pty.write(terminalId, "\x16"); // bitmap → bare ⌃V
				term.focus();
			}
		};
		el.addEventListener("paste", onPaste, true);

		// Dropping files behaves like pasting copied files.
		const onDragOver = (e: DragEvent) => e.preventDefault();
		const onDrop = (e: DragEvent) => {
			e.preventDefault();
			attachFiles(Array.from(e.dataTransfer?.files ?? []));
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

		// Reattach ordering matters: the snapshot is a point-in-time serialize of
		// the whole screen + modes, while live chunks keep streaming. If we wrote
		// live bytes straight away and the snapshot afterward, the two interleave —
		// recent bytes get applied twice and out of order, and a snapshot write can
		// land in the middle of a half-parsed live escape sequence (that's how a
		// CSI like `\x1b[21;57H` loses its prefix and leaks as literal `21;57H`).
		//
		// So we buffer live chunks until the snapshot is applied, then replay only
		// the ones the snapshot doesn't already include (seq > the snapshot's cut),
		// and finally switch to writing live directly. JS is single-threaded, so no
		// chunk can slip in between the flush and flipping `ready`.
		let ready = false;
		let pending: { data: string; seq: number }[] = [];
		const offData = window.ateam.pty.onData((e) => {
			if (e.terminalId !== terminalId) return;
			if (ready) term.write(e.data);
			else pending.push({ data: e.data, seq: e.seq });
		});

		void window.ateam.pty.snapshot(terminalId).then(({ data, seq }) => {
			if (data) term.write(data);
			for (const c of pending) if (c.seq > seq) term.write(c.data);
			pending = [];
			ready = true;
			// Scroll only once everything queued above has actually rendered.
			term.write("", () => term.scrollToBottom());
		});

		const disposeInput = term.onData((d) => window.ateam.pty.write(terminalId, d));

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
		let lastW = 0;
		let lastH = 0;
		let wasHidden = false;
		const syncSize = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				const w = el.clientWidth;
				const h = el.clientHeight;
				if (w === 0 || h === 0) {
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
				const gridChanged = term.cols !== lastCols || term.rows !== lastRows;
				const boxChanged = w !== lastW || h !== lastH;
				lastW = w;
				lastH = h;
				if (gridChanged) {
					lastCols = term.cols;
					lastRows = term.rows;
					window.ateam.pty.resize(terminalId, term.cols, term.rows);
				}
				// Repaint whenever the box changed, not just when the grid did: fit()
				// is a no-op on a sub-row resize (or a width change within the same
				// cols), but the DOM renderer can still be left with stale geometry —
				// which makes the visible height look wrong and mouse selection miss
				// until a remount. A forced refresh keeps it in sync without one.
				if (gridChanged || boxChanged || justRevealed) {
					term.refresh(0, term.rows - 1);
				}
				if (gridChanged || justRevealed) term.scrollToBottom();
			});
		};
		const ro = new ResizeObserver(syncSize);
		ro.observe(el);
		// A ResizeObserver on the absolutely-positioned host can miss a window
		// resize (its box tracks the containing block, and a reflow that ends at the
		// same size never fires), so also re-fit on the window's own resize.
		const onWinResize = () => syncSize();
		window.addEventListener("resize", onWinResize);
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
			window.removeEventListener("resize", onWinResize);
			offData();
			disposeInput.dispose();
			offResults.dispose();
			ro.disconnect();
			searchRef.current = null;
			termRef.current = null;
			term.dispose();
			// Search state is per-PTY: don't carry an open bar / stale count over
			// when this view is rebound to a different terminal.
			setSearchOpen(false);
			setResults(null);
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

	// "+ → Attach image": main opens a picker and stages the chosen image as a
	// bitmap on the clipboard, then we forward a bare Ctrl+V so the agent reads the
	// pixels off the clipboard — the one path that attaches reliably, regardless of
	// typed-path detection. Each click re-opens the picker, so you can add several
	// different images one after another.
	const attachImage = async () => {
		if (await window.ateam.utils.stageClipboardImage()) {
			window.ateam.pty.write(terminalId, "\x16");
		}
		termRef.current?.focus();
	};

	// ⌘F opens (or re-focuses) the search bar for THIS terminal only — keydown
	// bubbles up from whichever element inside the shell has focus, so in
	// Mission Control only the focused tile reacts. ⌘-combos never reach the
	// PTY (xterm leaves them to the browser), so nothing is swallowed.
	const onShellKeyDown = (e: React.KeyboardEvent) => {
		if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "f") {
			e.preventDefault();
			setSearchOpen(true);
			// select() rather than focus(): reopening with old text lets you type
			// a fresh query straight away (autoFocus covers the first open).
			requestAnimationFrame(() => searchInputRef.current?.select());
		}
	};

	const findNext = () => {
		if (query) searchRef.current?.findNext(query, { decorations: SEARCH_DECORATIONS });
	};
	const findPrev = () => {
		if (query) searchRef.current?.findPrevious(query, { decorations: SEARCH_DECORATIONS });
	};

	const onSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const q = e.target.value;
		setQuery(q);
		if (q) {
			// incremental: the current match grows with the query instead of
			// jumping to the next occurrence on every keystroke.
			searchRef.current?.findNext(q, { incremental: true, decorations: SEARCH_DECORATIONS });
		} else {
			searchRef.current?.clearDecorations();
			setResults(null);
		}
	};

	const closeSearch = () => {
		setSearchOpen(false);
		setResults(null);
		searchRef.current?.clearDecorations();
		termRef.current?.focus();
	};

	const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			e.preventDefault();
			if (e.shiftKey) findPrev();
			else findNext();
		} else if (e.key === "Escape") {
			e.preventDefault();
			closeSearch();
		}
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: shortcut listener, not an interactive element
		<div className="term-shell" onKeyDown={onShellKeyDown}>
			{/* .term-area is the flex-sized box; .term is absolutely positioned to
			    fill it, so the xterm canvas can never prop the layout open — the
			    available space drives the terminal size, not the other way round. */}
			<div className="term-area">
				<div className="term" ref={ref} />
				{searchOpen && (
					<div className="term-search">
						<input
							ref={searchInputRef}
							className="term-search-input"
							placeholder="Search"
							value={query}
							onChange={onSearchChange}
							onKeyDown={onSearchKeyDown}
							spellCheck={false}
							// biome-ignore lint/a11y/noAutofocus: the bar only exists because the user asked to search
							autoFocus
						/>
						<span className="term-search-count">
							{query && results
								? results.index >= 0
									? `${results.index + 1}/${results.count}`
									: `${results.count}`
								: ""}
						</span>
						<button type="button" title="Previous match (⇧↵)" onClick={findPrev}>
							<ChevronUp size={14} strokeWidth={1.75} />
						</button>
						<button type="button" title="Next match (↵)" onClick={findNext}>
							<ChevronDown size={14} strokeWidth={1.75} />
						</button>
						<button type="button" title="Close (Esc)" onClick={closeSearch}>
							<X size={14} strokeWidth={1.75} />
						</button>
					</div>
				)}
			</div>
			<div className="term-toolbar">
				<Menu
					icon={Plus}
					label="Add to terminal"
					items={[
						{ label: "Attach image", icon: ImageUp, onClick: attachImage },
						{ label: "Files…", icon: FileUp, onClick: addFiles },
					]}
				/>
				{showDone && (
					<button type="button" className="term-done primary" onClick={onDone}>
						Done
					</button>
				)}
			</div>
		</div>
	);
}
