/**
 * The text an OSC 52 clipboard write carries, or null when there is none.
 *
 * A program with no clipboard of its own copies through the terminal with
 * `ESC ] 52 ; Pc ; base64 BEL`. Claude Code does exactly that when it runs on
 * a box: its in-app drag selection copies natively on a Mac but sends OSC 52
 * over SSH, and xterm.js drops the sequence unless someone handles it.
 *
 * `data` is what xterm hands an OSC 52 handler: `Pc;Pd`. A `?` payload asks
 * the terminal to send its clipboard back. That is deliberately unsupported
 * (null): a program on a box must never be able to read the Mac's clipboard.
 */
export function osc52Text(data: string): string | null {
	const sep = data.indexOf(";");
	if (sep < 0) return null;
	const payload = data.slice(sep + 1);
	if (!payload || payload === "?") return null;
	try {
		const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null; // not base64, or not UTF-8
	}
}
