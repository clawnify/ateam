// The desktop half of reaching an SSH box's in-app services (the editor, the
// browser view): `-L` local forwards opened WITH the RPC connection
// (transport/ssh.ts sshFlags), so the tunnels live and die with the connection
// and no separate process needs managing. The local ports must be picked before
// the box is ever asked, so they're a pure function of the alias, and the box
// end is always loopback (packages/server/src/box-relay.ts says why).
import { DEFAULT_BROWSER_VIEW_PORT, DEFAULT_EDITOR_PORT } from "@ateam/protocol";

const RANGE = 500;
const EDITOR_BASE = 8391;
const BROWSER_BASE = 6081;

/** FNV-1a of the alias into base..base+RANGE. */
function portFor(alias: string, base: number): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < alias.length; i++) {
		h ^= alias.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return base + (h % RANGE);
}

/** Deterministic local forward port for an alias's editor. */
export function editorLocalPort(alias: string): number {
	return portFor(alias, EDITOR_BASE);
}

/** Deterministic local forward port for an alias's browser view. */
export function browserLocalPort(alias: string): number {
	return portFor(alias, BROWSER_BASE);
}

/**
 * Extra ssh flags for connect time. shortcut: two aliases can hash to one local
 * port — ssh then warns and skips the second forward (the connection itself is
 * unaffected); derive from a persisted per-alias slot if that ever bites.
 */
export function boxForwardFlags(alias: string): string[] {
	return [
		"-L",
		`${editorLocalPort(alias)}:127.0.0.1:${DEFAULT_EDITOR_PORT}`,
		"-L",
		`${browserLocalPort(alias)}:127.0.0.1:${DEFAULT_BROWSER_VIEW_PORT}`,
	];
}
