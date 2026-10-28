import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { BOARD_INSTRUCTIONS } from "../hooks/board-mcp";

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
# Claude's Notification hook is a general bus, not a "needs you" signal: it also
# fires on idle input (notification_type=idle_prompt, ~60s after a turn ends),
# on completion, auth and quota. Reporting all of it as PermissionRequest parked
# every finished task in needs_attention a minute after it succeeded, and wedged
# every loop (its next tick reads that status as "previous run still active").
# So a Notification payload — the only one carrying notification_type — passes
# only when a human genuinely has to act. Tool approvals are unaffected: they
# have their own dedicated PermissionRequest hook.
PAYLOAD=""
[ -t 0 ] || PAYLOAD=$(cat)
case "$PAYLOAD" in
	*notification_type*)
		case "$PAYLOAD" in
			*permission_prompt*|*agent_needs_input*|*elicitation_dialog*|*elicitation_url_dialog*) ;;
			*) exit 0 ;;
		esac
		;;
esac
# The reply is empty (204) unless this terminal has a follow-up armed, in which
# case it is the agent's own continuation JSON and stdout is where it belongs.
# A timeout or an unreachable app also yields empty, i.e. the old behaviour.
URL="http://127.0.0.1:\${PORT}/hook/complete?terminalId=\${TID}&eventType=\${EVENT}&sessionId=\${CLAUDE_SESSION_ID:-}"
# A turn's end and a user's reply carry the text the board classifier reads
# (Stop: last_assistant_message, UserPromptSubmit: prompt), so those two POST
# the hook's input. Everything else, PreToolUse above all (every tool call,
# with its arguments), stays a bodiless GET.
case "$EVENT" in
	Stop|UserReply)
		if [ -n "$PAYLOAD" ]; then
			BODY=$(printf '%s' "$PAYLOAD" | curl -s -m 2 --data-binary @- "$URL" 2>/dev/null || true)
		else
			BODY=$(curl -s -m 2 "$URL" 2>/dev/null || true)
		fi
		;;
	*) BODY=$(curl -s -m 2 "$URL" 2>/dev/null || true) ;;
esac
[ -n "$BODY" ] && printf '%s' "$BODY"
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
# Same follow-up echo as notify.sh. The notify program is fire-and-forget, so a
# follow-up only reaches the agent through .codex/hooks.json, where Stop shares
# Claude's hook schema.
# The payload rides along for the board classifier (see notify.sh).
BODY=$(printf '%s' "$1" | curl -s -m 2 --data-binary @- "http://127.0.0.1:\${PORT}/hook/complete?terminalId=\${TID}&eventType=\${EVENT}" 2>/dev/null || true)
[ -n "$BODY" ] && printf '%s' "$BODY"
exit 0
`;

/**
 * A `gh` shim placed FIRST on each agent's PATH. It intercepts `gh pr merge`
 * and routes it into Ateam's merge queue (so two agents merging into the same
 * base can't race); every other gh call passes straight through to the real gh.
 * It waits for the queue's verdict and prints it, exiting non-zero when nothing
 * merged (a conflict, a closed PR, an error), so the agent that asked can act on
 * it. Only an unreachable app (curl exit 7) or a terminal that belongs to no
 * task falls back to a real merge: a timeout or dropped connection may leave a
 * job running, and a second real merge must not race it.
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
	echo "Ateam: merging through the queue (merges into a base branch run one at a time)..." >&2
	OUT=$(curl -s -m 900 -w '\\n%{http_code}' "http://127.0.0.1:\${PORT}/merge/request?terminalId=\${TID}&strategy=\${STRAT}")
	RC=$?
	if [ "$RC" -eq 0 ]; then
		CODE=$(printf '%s\\n' "$OUT" | tail -n 1)
		MSG=$(printf '%s\\n' "$OUT" | sed '$d')
		case "$CODE" in
			200) printf '%s\\n' "$MSG"; exit 0 ;;
			404) ;;
			*) printf '%s\\n' "$MSG" >&2; exit 1 ;;
		esac
	elif [ "$RC" -ne 7 ]; then
		echo "Ateam: no answer from the merge queue (curl exit $RC); the merge may still be running. Check the board before running 'gh pr merge' again." >&2
		exit 1
	fi
	# App unreachable, or not a task terminal: fall through to a real merge.
fi

if [ -n "$REAL_GH" ]; then
	exec "$REAL_GH" "$@"
fi
echo "gh: command not found (and Ateam shim could not locate the real gh)" >&2
exit 127
`;

/**
 * Claude Code's peer-message listener (see peer-messages.ts). Registered for
 * SessionStart and Stop with `asyncRewake`: it runs in the background, waits on
 * Ateam's inbox for this terminal, and when a message arrives prints it to
 * stderr and exits 2, which wakes the session even while it sits idle at its
 * prompt (verified on Claude Code 2.1.310). Every Stop arms a fresh one; the
 * inbox keeps only the newest per terminal and answers the older one 409.
 *
 * 204 means the wait window passed with nothing: ask again. Any other answer
 * (409 replaced, 410 terminal gone, 401/404) ends this listener quietly. An
 * unreachable app (restarting) is retried for about half an hour.
 */
const INBOX_SCRIPT = `#!/bin/sh
# Ateam peer inbox for Claude Code. Runs as an asyncRewake hook.
PORT="\${ATEAM_HOOK_PORT:-}"
TID="\${ATEAM_TERMINAL_ID:-}"
TOKEN="\${ATEAM_TERMINAL_TOKEN:-}"
[ -t 0 ] || cat >/dev/null
[ -z "$PORT" ] && exit 0
[ -z "$TID" ] && exit 0
[ -z "$TOKEN" ] && exit 0
MISSES=0
while :; do
	OUT=$(curl -s -m 300 -w '\\n%{http_code}' -H "x-ateam-terminal-token: $TOKEN" "http://127.0.0.1:\${PORT}/inbox/wait?terminalId=\${TID}")
	RC=$?
	if [ "$RC" -ne 0 ]; then
		MISSES=$((MISSES + 1))
		[ "$MISSES" -gt 60 ] && exit 0
		sleep 30
		continue
	fi
	MISSES=0
	CODE=$(printf '%s\\n' "$OUT" | tail -n 1)
	case "$CODE" in
		200)
			printf '%s\\n' "$OUT" | sed '$d' >&2
			exit 2
			;;
		204) ;;
		*) exit 0 ;;
	esac
done
`;

/**
 * OpenCode's peer-message listener: a plugin, loaded per launch through
 * OPENCODE_CONFIG_CONTENT so the user's own config is untouched. It long-polls
 * the same inbox and hands each batch to the session as a prompt through
 * OpenCode's own server (`client.session.promptAsync`), which starts a turn on
 * an idle session (verified on OpenCode 1.18.34). A batch that arrives mid-turn
 * waits for that session's next idle.
 */
const OPENCODE_INBOX_PLUGIN = `// Ateam peer inbox for OpenCode. Written by Ateam; edits are overwritten.
export const AteamInbox = async ({ client }) => {
	const port = process.env.ATEAM_HOOK_PORT;
	const terminalId = process.env.ATEAM_TERMINAL_ID;
	const token = process.env.ATEAM_TERMINAL_TOKEN;
	if (!port || !terminalId || !token) return {};

	// Subagent sessions report too; only the conversation the TUI shows counts.
	const children = new Set();
	let sessionID = null;
	let busy = false;
	const held = [];

	const flush = async () => {
		if (busy || !sessionID || held.length === 0) return;
		const text = held.splice(0).join("\\n\\n---\\n\\n");
		busy = true;
		const res = await client.session
			.promptAsync({ path: { id: sessionID }, body: { parts: [{ type: "text", text }] } })
			.catch((e) => ({ error: e }));
		if (res?.error) {
			busy = false;
			held.unshift(text);
		}
	};

	(async () => {
		let misses = 0;
		for (;;) {
			let res;
			try {
				res = await fetch(\`http://127.0.0.1:\${port}/inbox/wait?terminalId=\${encodeURIComponent(terminalId)}\`, {
					headers: { "x-ateam-terminal-token": token },
				});
			} catch {
				if (++misses > 60) return;
				await new Promise((r) => setTimeout(r, 30000));
				continue;
			}
			misses = 0;
			if (res.status === 204) continue;
			if (res.status !== 200) return;
			held.push(await res.text());
			await flush();
		}
	})();

	return {
		event: async ({ event }) => {
			const p = event.properties ?? {};
			if (event.type === "session.created" || event.type === "session.updated") {
				if (p.info?.parentID) children.add(p.info.id);
				else if (p.info) sessionID = p.info.id;
				return;
			}
			if (p.sessionID && children.has(p.sessionID)) return;
			if (event.type === "session.status") busy = p.status?.type !== "idle";
			if (event.type === "session.idle") busy = false;
			if (!busy) {
				sessionID = p.sessionID ?? sessionID;
				await flush();
			}
		},
	};
};
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
	const inboxPath = join(hooksDir, "inbox.sh");
	await writeFile(inboxPath, INBOX_SCRIPT, "utf8");
	await chmod(inboxPath, 0o755);
	await writeFile(join(hooksDir, "opencode-inbox.js"), OPENCODE_INBOX_PLUGIN, "utf8");
	return scriptPath;
}

/**
 * The engine's secret for per-terminal tokens, created once and kept beside the
 * hooks (mode 0600). It must outlive the engine process: agents keep running
 * across app restarts and keep presenting the token they were launched with.
 */
export async function ensurePeerSecret(userDataDir: string): Promise<string> {
	const hooksDir = join(userDataDir, "hooks");
	await mkdir(hooksDir, { recursive: true });
	const file = join(hooksDir, "peer-secret");
	try {
		const existing = (await readFile(file, "utf8")).trim();
		if (existing.length >= 32) return existing;
	} catch {
		/* first run */
	}
	const secret = randomBytes(32).toString("hex");
	await writeFile(file, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
	return secret;
}

/**
 * The token a terminal's agent presents to the hook server for the peer tools
 * and its inbox. Derived, not stored: HMAC of the terminal id under the engine
 * secret. The terminal-id header alone is a claim any local process can make;
 * this is what keeps one from reading another task's messages or sending in its
 * name (and, on a shared box, keeps other Unix users out).
 */
export function peerToken(secret: string, terminalId: string): string {
	return createHmac("sha256", secret).update(terminalId).digest("hex");
}

export function verifyPeerToken(secret: string, terminalId: string, token: string): boolean {
	const want = Buffer.from(peerToken(secret, terminalId));
	const got = Buffer.from(token);
	return want.length === got.length && timingSafeEqual(want, got);
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
	hooks: { type: "command"; command: string; asyncRewake?: boolean }[];
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

	// A call to the box browser's tools (TaskWindow, registered as `taskwindow` by
	// install-browser.sh) is how the engine learns this task uses the browser
	// (Task.browserUsedAt). Its own entry, so the PreToolUse check above, which
	// sees any notify.sh, can't count it as already there.
	const pre = settings.hooks.PreToolUse ?? [];
	if (
		!pre.some((e) =>
			e.hooks.some((h) => h.command.includes("notify.sh") && h.command.includes("BrowserUse")),
		)
	) {
		pre.push({
			matcher: "mcp__taskwindow__.*",
			hooks: [{ type: "command", command: cmd("BrowserUse") }],
		});
		settings.hooks.PreToolUse = pre;
	}

	// The peer inbox listener (INBOX_SCRIPT): armed when the session starts and
	// again after every turn, in the background, so a message can wake it.
	const inbox = `sh ${JSON.stringify(join(dirname(notifyScriptPath), "inbox.sh"))}`;
	for (const claudeEvent of ["SessionStart", "Stop"]) {
		const entries = settings.hooks[claudeEvent] ?? [];
		if (!entries.some((e) => e.hooks.some((h) => h.command.includes("inbox.sh")))) {
			entries.push({ hooks: [{ type: "command", command: inbox, asyncRewake: true }] });
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

/**
 * Write a per-session MCP config pointing Claude at Ateam's board tools (served
 * on the hook server's `/mcp` endpoint). The session's terminal id rides along
 * as a header so `set_status` can tell a self-move (a session moving its OWN
 * card) from an organizer move. Pass an empty `terminalId` for the board-level
 * organizer, which is bound to no single task. Returns the file path to hand to
 * `claude --mcp-config`.
 */
export async function ensureBoardMcpConfig(opts: {
	hooksDir: string;
	hookPort: number;
	terminalId: string;
	/** The terminal's peer token (see peerToken); omitted for the organizer. */
	token?: string;
}): Promise<string> {
	const dir = join(opts.hooksDir, "mcp");
	await mkdir(dir, { recursive: true });
	const file = join(dir, `board-${opts.terminalId || "organizer"}.json`);
	const config = {
		mcpServers: {
			ateam_board: {
				type: "http",
				url: `http://127.0.0.1:${opts.hookPort}/mcp`,
				headers: {
					"x-ateam-terminal-id": opts.terminalId,
					...(opts.token ? { "x-ateam-terminal-token": opts.token } : {}),
				},
			},
		},
	};
	// 0600: the file carries the terminal's token.
	await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await chmod(file, 0o600);
	return file;
}

/** The board tools, named for `claude --allowedTools`. */
export const BOARD_MCP_TOOLS = [
	"mcp__ateam_board__get_board",
	"mcp__ateam_board__set_status",
	"mcp__ateam_board__set_waiting",
	"mcp__ateam_board__list_peers",
	"mcp__ateam_board__send_message",
	"mcp__ateam_board__ask_user",
];

/**
 * Codex's `-c` overrides for the same MCP server: per launch, so the user's
 * ~/.codex/config.toml is untouched. The headers are read from the PTY env
 * (`env_http_headers`), so the token never lands on the command line or in a
 * file. Verified with `codex mcp get` on 0.162.1. Codex ignores an MCP
 * server's instructions, so they go in as developer_instructions.
 * shortcut: this replaces a developer_instructions the user set in their own
 * config.toml; merge with it if anyone sets one.
 */
export function codexBoardMcpArgs(hookPort: number): string {
	return [
		`-c 'mcp_servers.ateam_board.url="http://127.0.0.1:${hookPort}/mcp"'`,
		`-c 'developer_instructions="${BOARD_INSTRUCTIONS}"'`,
		`-c 'mcp_servers.ateam_board.env_http_headers={"x-ateam-terminal-id"="ATEAM_TERMINAL_ID","x-ateam-terminal-token"="ATEAM_TERMINAL_TOKEN"}'`,
		// Pre-approved like Claude's --allowedTools: guarded server-side, so an
		// approval prompt would only stall the agent a message just woke.
		...BOARD_MCP_TOOLS.map(
			(t) =>
				`-c 'mcp_servers.ateam_board.tools.${t.replace("mcp__ateam_board__", "")}.approval_mode="approve"'`,
		),
	].join(" ");
}

/**
 * OpenCode's per-launch config (OPENCODE_CONFIG_CONTENT): the board MCP server
 * and the inbox plugin, merged over whatever the user already passes there.
 * `{env:…}` is OpenCode's own substitution, so the token stays in the env.
 */
export function opencodeConfigContent(opts: {
	hookPort: number;
	hooksDir: string;
	existing?: string;
}): string {
	let base: { plugin?: unknown; mcp?: Record<string, unknown>; [k: string]: unknown } = {};
	try {
		if (opts.existing) base = JSON.parse(opts.existing);
	} catch {
		/* not JSON: OpenCode would reject it too; ours replaces it */
	}
	const plugins = Array.isArray(base.plugin) ? base.plugin : [];
	return JSON.stringify({
		...base,
		plugin: [...plugins, pathToFileURL(join(opts.hooksDir, "opencode-inbox.js")).href],
		mcp: {
			...(base.mcp ?? {}),
			ateam_board: {
				type: "remote",
				url: `http://127.0.0.1:${opts.hookPort}/mcp`,
				headers: {
					"x-ateam-terminal-id": "{env:ATEAM_TERMINAL_ID}",
					"x-ateam-terminal-token": "{env:ATEAM_TERMINAL_TOKEN}",
				},
			},
		},
	});
}

/** Build the PTY environment for an agent session, injecting hook correlation. */
export function buildAgentEnv(opts: {
	terminalId: string;
	agentId: string;
	hookPort: number;
	hooksDir: string;
	/** The terminal's peer token (see peerToken). */
	token?: string;
}): NodeJS.ProcessEnv {
	return {
		...process.env,
		ATEAM_TERMINAL_ID: opts.terminalId,
		ATEAM_AGENT_ID: opts.agentId,
		ATEAM_HOOK_PORT: String(opts.hookPort),
		...(opts.token ? { ATEAM_TERMINAL_TOKEN: opts.token } : {}),
		...(opts.agentId === "opencode"
			? {
					OPENCODE_CONFIG_CONTENT: opencodeConfigContent({
						hookPort: opts.hookPort,
						hooksDir: opts.hooksDir,
						existing: process.env.OPENCODE_CONFIG_CONTENT,
					}),
				}
			: {}),
		// The gh shim reads this to strip itself from PATH and find the real gh.
		ATEAM_HOOKS_DIR: opts.hooksDir,
		PATH: `${opts.hooksDir}:${process.env.PATH ?? ""}`,
	};
}
