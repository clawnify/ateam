// Messages into a live Codex conversation without restarting it.
//
// Codex 0.165 has a queue for each conversation: `codex queue --thread <id>
// --message <text>` adds a user turn that the Codex holding the thread takes
// as soon as it can. Verified live on 0.165.0 (2026-11-06), in a TUI like the
// one Ateam runs:
//   - idle: it starts the turn at once, in place, shown as a prompt;
//   - mid-turn: it waits in Codex's queue and runs when that turn ends;
//   - a draft in the composer stays where it is, untouched;
//   - no Codex has the thread open: it waits, and runs as soon as one opens it;
//   - it fires UserPromptSubmit like a typed prompt.
// So a message reaches a Codex the way a typed prompt would, with no restart,
// no new tab and no wait for the agent to go idle. The call takes ~0.6 s,
// login shell included. A Codex without the subcommand fails at once (exit 2,
// "unexpected argument '--thread'") without starting anything.
import { execFile } from "node:child_process";
import { shell } from "./headless";

const QUEUE_TIMEOUT_MS = 30_000;

/** Runs a login-shell command line in `cwd`, as the agent's own launch does. */
export type RunShell = (command: string, cwd: string) => Promise<{ ok: boolean; stdout: string }>;

const runShell: RunShell = (command, cwd) =>
	new Promise((resolve) => {
		execFile(shell, ["-lc", command], { cwd, timeout: QUEUE_TIMEOUT_MS }, (err, stdout) =>
			resolve({ ok: !err, stdout: String(stdout) }),
		);
	});

const sq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/**
 * Queue `text` for the Codex conversation `threadId`. True once Codex says it
 * queued it; false for anything else (no `queue` subcommand, an unknown
 * thread, no `codex` here), so the caller can take its old way in.
 */
export async function queueCodexMessage(
	threadId: string,
	text: string,
	cwd: string,
	run: RunShell = runShell,
): Promise<boolean> {
	// argv cannot carry a NUL.
	const message = text.replaceAll("\0", "");
	const { ok, stdout } = await run(
		`codex queue --thread ${sq(threadId)} --message ${sq(message)}`,
		cwd,
	);
	return ok && stdout.includes("Queued message");
}
