/**
 * Follows the prompt you are typing into an agent's TUI from the keystrokes
 * xterm sends to the PTY (term.onData), never from the screen. Every agent
 * draws its input box differently, but the bytes we send it are ours, so this
 * works the same for Claude Code, Codex and OpenCode.
 *
 * The tracker only claims to know the draft while the caret must still be at
 * its end: typing, backspacing and pasting keep it in sync. Anything that can
 * move the caret or rewrite the text behind our back (arrows, history, Tab
 * completion, a lone Esc) drops it to `null`, "unknown". Enter (submit) and
 * Ctrl+C (clear) empty the input in every agent, so they resync to "".
 */
export class DraftTracker {
	/** The current draft, or null when we can no longer vouch for it. */
	draft: string | null = "";

	feed(data: string): void {
		let i = 0;
		while (i < data.length) {
			const ch = data.charAt(i);
			if (ch === "\x1b") {
				i = this.escape(data, i);
				continue;
			}
			i++;
			if (ch === "\r") {
				// Claude Code turns a trailing `\` + Enter into a newline.
				if (this.draft?.endsWith("\\")) this.draft = `${this.draft.slice(0, -1)}\n`;
				else this.draft = "";
			} else if (ch === "\x7f" || ch === "\b") {
				if (this.draft !== null) this.draft = Array.from(this.draft).slice(0, -1).join("");
			} else if (ch === "\x17") {
				this.deleteWord();
			} else if (ch === "\x15") {
				// Ctrl+U: kill back to the start of the current line.
				if (this.draft !== null) this.draft = this.draft.slice(0, this.draft.lastIndexOf("\n") + 1);
			} else if (ch === "\x03") {
				this.draft = "";
			} else if (ch < " ") {
				// Tab completion and every other control key: we can't follow it.
				this.draft = null;
			} else if (this.draft !== null) {
				this.draft += ch;
			}
		}
	}

	/** Consume the escape sequence at `i`, returning the index after it. */
	private escape(data: string, i: number): number {
		const next = data[i + 1];
		if (next === "[") {
			let j = i + 2;
			while (j < data.length && !(data.charCodeAt(j) >= 0x40 && data.charCodeAt(j) <= 0x7e)) j++;
			const seq = data.slice(i, j + 1);
			if (seq === "\x1b[200~") return this.paste(data, j + 1);
			// Focus reports (mode 1004) and mouse reports (wheel, clicks in a TUI
			// that captured the mouse) don't touch the input text.
			if (seq === "\x1b[I" || seq === "\x1b[O" || seq.startsWith("\x1b[<")) return j + 1;
			if (seq === "\x1b[M") return j + 4; // X10 mouse: three payload bytes follow
			this.draft = null; // arrows, Home/End, Delete, ...
			return j + 1;
		}
		if (next === "O") {
			this.draft = null; // SS3 arrows and F-keys
			return i + 3;
		}
		if (next === "\r") {
			// Option+Enter: a newline in the draft, not a submit.
			if (this.draft !== null) this.draft += "\n";
			return i + 2;
		}
		if (next === "\x7f") {
			this.deleteWord(); // Option+Backspace
			return i + 2;
		}
		// A lone Esc (interrupt, or the first half of Esc Esc "clear") or Meta+key.
		this.draft = null;
		return next === undefined ? i + 1 : i + 2;
	}

	/** Bracketed paste: the text up to the closing marker lands in the draft verbatim. */
	private paste(data: string, from: number): number {
		const end = data.indexOf("\x1b[201~", from);
		const text = data.slice(from, end === -1 ? undefined : end).replace(/\r\n?/g, "\n");
		if (this.draft !== null) this.draft += text;
		return end === -1 ? data.length : end + 6;
	}

	/** Ctrl+W / Option+Backspace: drop the last word and the space after it. */
	private deleteWord(): void {
		if (this.draft !== null) this.draft = this.draft.replace(/\S*\s*$/, "");
	}
}

/**
 * How to turn the draft `from` into `to` from a caret at its end: backspace to
 * where they first differ, then retype the rest. Counted in code points, the
 * unit the tracker's own backspace removes.
 */
export function retype(from: string, to: string): { backspaces: number; tail: string } {
	const a = Array.from(from);
	const b = Array.from(to);
	let same = 0;
	while (same < a.length && same < b.length && a[same] === b[same]) same++;
	return { backspaces: a.length - same, tail: b.slice(same).join("") };
}
