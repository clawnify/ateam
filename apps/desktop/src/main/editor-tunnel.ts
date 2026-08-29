// The desktop half of reaching an SSH box's in-app editor: a `-L` local forward
// opened WITH the RPC connection (transport/ssh.ts sshFlags), so the tunnel lives
// and dies with the connection and no separate process needs managing. The local
// port must be picked before the box is ever asked, so it's a pure function of
// the alias.
import { DEFAULT_EDITOR_PORT } from "@ateam/protocol";

const BASE = 8391;
const RANGE = 500;

/** Deterministic local forward port for an alias (FNV-1a into BASE..BASE+RANGE). */
export function editorLocalPort(alias: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < alias.length; i++) {
		h ^= alias.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return BASE + (h % RANGE);
}

/**
 * Extra ssh flags for connect time. shortcut: two aliases can hash to one local
 * port — ssh then warns and skips the second forward (the connection itself is
 * unaffected); derive from a persisted per-alias slot if that ever bites.
 */
export function editorForwardFlags(alias: string): string[] {
	return ["-L", `${editorLocalPort(alias)}:127.0.0.1:${DEFAULT_EDITOR_PORT}`];
}
