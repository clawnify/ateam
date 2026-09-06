// Snapshot state the serialize addon does not carry.
//
// The daemon's snapshot is `SerializeAddon.serialize()`, which replays every
// DEC mode xterm exposes through `terminal.modes` — alt screen, bracketed
// paste, focus reporting, mouse TRACKING (?1000/?1002/?1003). It has no way to
// replay the mouse ENCODING (?1006 SGR, ?1016 SGR-pixels): `modes` does not
// expose it, so `serialize()` never writes it.
//
// That gap breaks the mouse on reattach for any TUI that owns it (OpenCode
// enables ?1003 + ?1006 at startup). The fresh renderer replays ?1003h without
// ?1006h, so its xterm falls back to the legacy X10 encoding — which xterm
// emits on `onBinary`, not `onData`, and the views only forward `onData`.
// Every wheel, click and drag is silently dropped until the app restarts.
//
// Fix, daemon side: watch the encoding requests as they stream through the
// emulator's own parser (so split chunks are handled for us) and append the
// active one to the snapshot. Handlers return false so xterm's built-in
// handling still runs.
import type { Terminal } from "@xterm/headless";

const SGR = "\x1b[?1006h";
const SGR_PIXELS = "\x1b[?1016h";
// Explicit "tracking is on, encoding is the default" marker. The daemon writes
// it so the app side can tell a deliberate default apart from a snapshot that
// simply predates encoding tracking (see withMouseEncoding).
const DEFAULT_ENCODING = "\x1b[?1006l";

const TRACKING_ON = /\x1b\[\?(?:1000|1002|1003)h/;
const ENCODING_STATED = /\x1b\[\?(?:1006|1016)[hl]/;

/**
 * Track the mouse encoding an app has requested on `term`. Returns a getter
 * for the sequence to append to a snapshot: the active encoding's set-mode
 * sequence, the explicit default marker while tracking is on, or "" when the
 * app does not own the mouse at all.
 */
export function trackMouseEncoding(term: Terminal): () => string {
	let active = "";
	const flat = (params: (number | number[])[]) => params.flat();
	term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
		for (const p of flat(params)) {
			if (p === 1006) active = SGR;
			else if (p === 1016) active = SGR_PIXELS;
		}
		return false;
	});
	// Resetting either encoding puts xterm back on the default one.
	term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
		for (const p of flat(params)) if (p === 1006 || p === 1016) active = "";
		return false;
	});
	// RIS (full reset) drops every mode, encoding included.
	term.parser.registerEscHandler({ final: "c" }, () => {
		active = "";
		return false;
	});
	return () => {
		if (active) return active;
		return term.modes.mouseTrackingMode === "none" ? "" : DEFAULT_ENCODING;
	};
}

/**
 * App-side fallback for snapshots from a daemon that predates encoding
 * tracking. The daemon is a detached process that outlives app updates, so a
 * user can run a new app against an old daemon for weeks; its snapshots
 * replay mouse tracking with no encoding stated either way. Every TUI Ateam
 * launches that owns the mouse asks for SGR (the legacy encoding cannot even
 * address a wide pane), and without it the reports are dropped anyway, so
 * assuming SGR is the strictly better guess. A daemon that tracks encodings
 * always states one when tracking is on, so this never second-guesses it.
 */
export function withMouseEncoding(snapshot: string): string {
	if (!TRACKING_ON.test(snapshot) || ENCODING_STATED.test(snapshot)) return snapshot;
	return snapshot + SGR;
}
