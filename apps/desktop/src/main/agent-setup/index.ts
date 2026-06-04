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

/** Write the shared notify.sh into Ateam's userData dir; returns its path. */
export async function ensureNotifyScript(userDataDir: string): Promise<string> {
	const hooksDir = join(userDataDir, "hooks");
	await mkdir(hooksDir, { recursive: true });
	const scriptPath = join(hooksDir, "notify.sh");
	await writeFile(scriptPath, NOTIFY_SCRIPT, "utf8");
	await chmod(scriptPath, 0o755);
	return scriptPath;
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
		Notification: "PermissionRequest",
		PreToolUse: "Working",
		UserPromptSubmit: "Working",
	};

	settings.hooks ??= {};
	for (const [claudeEvent, ateamEvent] of Object.entries(map)) {
		const command = cmd(ateamEvent);
		const entries = settings.hooks[claudeEvent] ?? [];
		const already = entries.some((e) =>
			e.hooks.some((h) => h.command.includes("notify.sh")),
		);
		if (!already) {
			entries.push({ hooks: [{ type: "command", command }] });
			settings.hooks[claudeEvent] = entries;
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
		PATH: `${opts.hooksDir}:${process.env.PATH ?? ""}`,
	};
}
