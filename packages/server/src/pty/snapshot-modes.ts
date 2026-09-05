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
// Fix: watch the encoding requests as they stream through the emulator's own
// parser (so split chunks are handled for us) and append the active one to the
// snapshot. Handlers return false so xterm's built-in handling still runs.
import type { Terminal } from "@xterm/headless";

const SGR = "\x1b[?1006h";
const SGR_PIXELS = "\x1b[?1016h";

/**
 * Track the mouse encoding an app has requested on `term`. Returns a getter
 * for the sequence to append to a snapshot: the active encoding's set-mode
 * sequence, or "" when the app is on the default (or reset) encoding.
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
	return () => active;
}
