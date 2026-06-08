import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Per-PTY status hooks. We keep this NON-INVASIVE: instead of editing the
 * user's global ~/.claude/settings.json, we drop a notify script in Ateam's
 * userData dir and register hooks in each worktree's local
 * `.claude/settings.local.json`. The hook command reads $ATEAM_* from the PTY
 * env (injected per session), so the same script serves every terminal.
 */

const NOTIFY_SCRIPT = `#!/bin/sh
# Ateam agent status hook. Usage: notify.sh <EventType>
# Reads ATEAM_HOOK_PORT and ATEAM_TERMINAL_ID from the agent's PTY env.
# (GROVE_* fallbacks keep sessions spawned by older versions reporting.)
PORT="\${ATEAM_HOOK_PORT:-\${GROVE_HOOK_PORT:-}}"
TID="\${ATEAM_TERMINAL_ID:-\${GROVE_TERMINAL_ID:-}}"
[ -z "$PORT" ] && exit 0
[ -z "$TID" ] && exit 0
EVENT="\${1:-Stop}"
curl -s -m 2 "http://127.0.0.1:\${PORT}/hook/complete?terminalId=\${TID}&eventType=\${EVENT}&sessionId=\${CLAUDE_SESSION_ID:-}" >/dev/null 2>&1 || true
exit 0
`;

/**
 * Codex has no Claude-style hooks, but its `notify` config invokes a program
 * with a JSON payload on lifecycle events. We map turn completion to Stop
 * (and any approval-flavored event to PermissionRequest, future-proofing).
 */
const CODEX_NOTIFY_SCRIPT = `#!/bin/sh
# Ateam status hook for Codex. Codex calls this with one JSON argument.
PORT="\${ATEAM_HOOK_PORT:-}"
TID="\${ATEAM_TERMINAL_ID:-}"
[ -z "$PORT" ] && exit 0
[ -z "$TID" ] && exit 0
case "$1" in
	*agent-turn-complete*) EVENT="Stop" ;;
	*approval*) EVENT="PermissionRequest" ;;
	*) exit 0 ;;
esac
curl -s -m 2 "http://127.0.0.1:\${PORT}/hook/complete?terminalId=\${TID}&eventType=\${EVENT}" >/dev/null 2>&1 || true
exit 0
`;

/**
 * A `gh` shim placed FIRST on each agent's PATH. It intercepts `gh pr merge`
 * and routes it into Ateam's merge queue (so two agents merging into the same
 * base can't race); every other gh call passes straight through to the real gh.
 * If the app isn't reachable it falls back to a real merge rather than blocking.
 * Only agent PTYs get this dir on PATH — the main process keeps the real gh.
 */
const GH_SHIM = `#!/bin/sh
PORT="\${ATEAM_HOOK_PORT:-}"
TID="\${ATEAM_TERMINAL_ID:-}"
SHIM_DIR="\${ATEAM_HOOKS_DIR:-}"

# Resolve the real gh from PATH with our shim dir removed.
REALPATH=$(printf '%s' "$PATH" | awk -v RS=: -v d="$SHIM_DIR" 'NF && $0!=d' | paste -sd: -)
REAL_GH=$(PATH="$REALPATH" command -v gh 2>/dev/null)

if [ "$1" = "pr" ] && [ "$2" = "merge" ] && [ -n "$PORT" ] && [ -n "$TID" ]; then
	STRAT=""
	for a in "$@"; do
		case "$a" in
			--squash) STRAT=squash ;;
			--merge) STRAT=merge ;;
			--rebase) STRAT=rebase ;;
		esac
	done
	if curl -s -m 3 "http://127.0.0.1:\${PORT}/merge/request?terminalId=\${TID}&strategy=\${STRAT}" >/dev/null 2>&1; then
		echo "Ateam: merge queued. Ateam serializes merges per base branch so concurrent merges never conflict — this PR will merge in turn and the board will show its status. Do not re-run 'gh pr merge'."
		exit 0
	fi
	# App unreachable — fall through to a real merge rather than blocking.
fi

if [ -n "$REAL_GH" ]; then
	exec "$REAL_GH" "$@"
fi
echo "gh: command not found (and Ateam shim could not locate the real gh)" >&2
exit 127
`;

/** Write the notify scripts into Ateam's userData dir; returns notify.sh's path. */
export async function ensureNotifyScript(userDataDir: string): Promise<string> {
	const hooksDir = join(userDataDir, "hooks");
	await mkdir(hooksDir, { recursive: true });
	const scriptPath = join(hooksDir, "notify.sh");
	await writeFile(scriptPath, NOTIFY_SCRIPT, "utf8");
	await chmod(scriptPath, 0o755);
	const codexPath = join(hooksDir, "codex-notify.sh");
	await writeFile(codexPath, CODEX_NOTIFY_SCRIPT, "utf8");
	await chmod(codexPath, 0o755);
	return scriptPath;
}

/** Write the `gh` merge-queue shim into Ateam's hooks dir (first on agent PATH). */
export async function ensureGhShim(userDataDir: string): Promise<void> {
	const hooksDir = join(userDataDir, "hooks");
	await mkdir(hooksDir, { recursive: true });
	const shimPath = join(hooksDir, "gh");
	await writeFile(shimPath, GH_SHIM, "utf8");
	await chmod(shimPath, 0o755);
}

interface ClaudeHookEntry {
	matcher?: string;
	hooks: { type: "command"; command: string }[];
}
interface ClaudeSettings {
	hooks?: Record<string, ClaudeHookEntry[]>;
	[k: string]: unknown;
}

/**
 * Register Ateam's status hooks in `<worktree>/.claude/settings.local.json`
 * (scoped to this worktree, never touches global config). Maps Claude's
 * lifecycle events to our notify script with a literal event type:
 *   SessionStart → Start · Stop → Stop · Notification → PermissionRequest
 *   PreToolUse/UserPromptSubmit → Working (the agent resumed after the user
 *   answered a permission prompt or typed a reply — moves the card back to
 *   "running"; without these it would sit in needs_attention until Stop).
 */
export async function ensureClaudeHooks(
	worktreePath: string,
	notifyScriptPath: string,
): Promise<void> {
	const dir = join(worktreePath, ".claude");
	await mkdir(dir, { recursive: true });
	const file = join(dir, "settings.local.json");

	let settings: ClaudeSettings = {};
	try {
		settings = JSON.parse(await readFile(file, "utf8")) as ClaudeSettings;
	} catch {
		/* no existing file */
	}

	const cmd = (event: string) => `sh ${JSON.stringify(notifyScriptPath)} ${event}`;
	const map: Record<string, string> = {
		SessionStart: "Start",
		Stop: "Stop",
		// Dedicated dialog hook — fires the moment a permission prompt appears
		// (Notification may stay quiet while the terminal has focus).
		PermissionRequest: "PermissionRequest",
		Notification: "PermissionRequest",
		PreToolUse: "Working",
		// Typing a reply is the only unambiguous "user responded" signal —
		// subagent tool-use also fires PreToolUse, so Working can't clear
		// needs_attention without masking pending questions.
		UserPromptSubmit: "UserReply",
	};

	settings.hooks ??= {};
	for (const [claudeEvent, ateamEvent] of Object.entries(map)) {
		const command = cmd(ateamEvent);
		const entries = settings.hooks[claudeEvent] ?? [];
		const already = entries.some((e) => e.hooks.some((h) => h.command.includes("notify.sh")));
		if (!already) {
			entries.push({ hooks: [{ type: "command", command }] });
			settings.hooks[claudeEvent] = entries;
		}
	}

	await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

/**
 * Register Ateam's status hooks in `<worktree>/.codex/hooks.json` — Codex
 * supports the same lifecycle-event schema as Claude Code (verified against
 * the Codex config reference). Project-local hooks load once the repo's
 * `.codex` layer is trusted; the `notify` override injected at launch covers
 * Stop until then.
 */
export async function ensureCodexHooks(
	worktreePath: string,
	notifyScriptPath: string,
): Promise<void> {
	const dir = join(worktreePath, ".codex");
	await mkdir(dir, { recursive: true });
	const file = join(dir, "hooks.json");

	let settings: ClaudeSettings = {};
	try {
		settings = JSON.parse(await readFile(file, "utf8")) as ClaudeSettings;
	} catch {
		/* no existing file */
	}

	const cmd = (event: string) => `sh ${JSON.stringify(notifyScriptPath)} ${event}`;
	const map: Record<string, string> = {
		SessionStart: "Start",
		Stop: "Stop",
		PermissionRequest: "PermissionRequest",
		PreToolUse: "Working",
		UserPromptSubmit: "UserReply",
	};

	settings.hooks ??= {};
	for (const [codexEvent, ateamEvent] of Object.entries(map)) {
		const command = cmd(ateamEvent);
		const entries = settings.hooks[codexEvent] ?? [];
		const already = entries.some((e) => e.hooks.some((h) => h.command.includes("notify.sh")));
		if (!already) {
			entries.push({ hooks: [{ type: "command", command }] });
			settings.hooks[codexEvent] = entries;
		}
	}

	await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

/** Build the PTY environment for an agent session, injecting hook correlation. */
export function buildAgentEnv(opts: {
	terminalId: string;
	agentId: string;
	hookPort: number;
	hooksDir: string;
}): NodeJS.ProcessEnv {
	return {
		...process.env,
		ATEAM_TERMINAL_ID: opts.terminalId,
		ATEAM_AGENT_ID: opts.agentId,
		ATEAM_HOOK_PORT: String(opts.hookPort),
		// The gh shim reads this to strip itself from PATH and find the real gh.
		ATEAM_HOOKS_DIR: opts.hooksDir,
		PATH: `${opts.hooksDir}:${process.env.PATH ?? ""}`,
	};
}
