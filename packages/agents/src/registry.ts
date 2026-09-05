import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

export type PromptTransport = "argv" | "stdin";

export interface AgentDefinition {
	id: string;
	label: string;
	description: string;
	/** Binary name, used both for the availability probe and to spawn. */
	bin: string;
	/**
	 * Default command line — the SAFE interactive mode that asks for approval
	 * before dangerous actions.
	 */
	command: string;
	/**
	 * Extra flag(s) appended for "YOLO" mode (bypass permissions/approvals).
	 * Omitted for agents that have no such flag (e.g. OpenCode).
	 */
	yoloFlag?: string;
	/**
	 * Command that resumes the most recent conversation in the cwd — used to
	 * pick a session back up after the agent process ended (e.g. app restart).
	 */
	resumeCommand?: string;
	/**
	 * Flag that pins a NEW conversation to an id we choose (`--session-id <uuid>`).
	 * This is what makes a tab restorable: every tab in a task shares one
	 * worktree, so `resumeCommand` ("the most recent conversation in the cwd")
	 * can only ever bring back one of them. Minting the id at launch gives each
	 * tab its own handle, which `resumeIdCommand` takes back. Omitted for a CLI
	 * that insists on minting its own.
	 */
	sessionIdFlag?: string;
	/**
	 * Command that resumes ONE named conversation — the id goes straight after
	 * it. Every harness can do this; only some let us choose the id up front.
	 */
	resumeIdCommand?: string;
	/**
	 * "Agent mode" command — the tool's autonomous multi-agent surface (e.g.
	 * Claude Code's `claude agents` board), launched in the task's worktree.
	 * Omitted for agents without one.
	 */
	agentsCommand?: string;
	/** How an initial task prompt is delivered (if supported). */
	promptTransport?: PromptTransport;
	/** Non-interactive command that installs this agent's CLI on a box (run in a
	 *  login shell over SSH). Omitted if we don't know how to install it. */
	install?: string;
	/** The one-time OAuth login the user runs on the box after install (browser flow). */
	loginCommand?: string;
	/**
	 * How to ask this agent ONE question non-interactively and read the answer
	 * back as text — no PTY, no session, no tools. Ateam uses it for the small
	 * model-shaped jobs inside the app itself (ranking session-search results),
	 * so those stay on whatever agent the user already runs rather than hard-
	 * wiring one vendor's CLI. Omitted for an agent with no such mode.
	 */
	headless?: HeadlessInvocation;
}

/** A one-shot, non-interactive call to an agent CLI. */
export interface HeadlessInvocation {
	/** Flags after the binary (the prompt is delivered separately). */
	args: string[];
	/** Where the prompt goes: piped on stdin, or appended as arguments. */
	prompt: PromptTransport;
	/**
	 * Flag that writes the final assistant message to a file. Set it for CLIs
	 * whose stdout carries progress chrome (Codex); when absent, stdout IS the
	 * answer (Claude's `--output-format text`).
	 */
	lastMessageFlag?: string;
}

// Registry of the supported agent CLIs. Command lines and the YOLO bypass
// flags come from each tool's own documented CLI surface. `command` is the
// SAFE default; `yoloFlag` is what makes it autonomous.
export const AGENTS = [
	{
		id: "claude",
		label: "Claude Code",
		description:
			"Anthropic's coding agent for reading code, editing files, and running terminal workflows.",
		bin: "claude",
		command: "claude",
		yoloFlag: "--permission-mode auto",
		resumeCommand: "claude --continue",
		// Verified against the CLI itself: `--session-id <uuid>` names the
		// transcript (~/.claude/projects/<slug>/<uuid>.jsonl) and `--resume <uuid>`
		// returns to it without forking.
		sessionIdFlag: "--session-id",
		resumeIdCommand: "claude --resume",
		agentsCommand: "claude agents",
		install: "curl -fsSL https://claude.ai/install.sh | bash",
		loginCommand: "claude login",
		// --safe-mode drops hooks/CLAUDE.md/skills/MCP, --restricted drops the
		// command-running tools: this asks a question, it does not do work in a
		// repo. Both together take the call from ~50s to ~3s. Haiku because the
		// job is ranking a shortlist someone else already built, and it is on
		// the path of a UI keystroke.
		headless: {
			args: ["-p", "--safe-mode", "--restricted", "--model", "haiku", "--output-format", "text"],
			prompt: "stdin",
		},
	},
	{
		id: "codex",
		label: "Codex",
		description: "OpenAI's coding agent for reading, modifying, and running code across tasks.",
		bin: "codex",
		command: "codex",
		yoloFlag: "--dangerously-bypass-approvals-and-sandbox",
		resumeCommand: "codex resume --last",
		// `codex resume [SESSION_ID]` takes a UUID, but Codex mints it itself —
		// there is no flag to hand it one, so its tabs stay unrestorable until
		// the id is read back out of its transcript store.
		resumeIdCommand: "codex resume",
		install: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
		loginCommand: "codex login",
		// `codex exec` streams its progress to stdout, so the answer is taken
		// from --output-last-message instead. read-only sandbox + no git-repo
		// requirement: the prompt is self-contained, there is nothing to touch.
		headless: {
			args: ["exec", "--skip-git-repo-check", "--sandbox", "read-only"],
			prompt: "stdin",
			lastMessageFlag: "--output-last-message",
		},
	},
	{
		id: "opencode",
		label: "OpenCode",
		description: "Open-source coding agent for the terminal, IDE, and desktop.",
		bin: "opencode",
		command: "opencode",
		resumeCommand: "opencode --continue",
		// Same shape as Codex: `-s/--session <id>` continues a named session,
		// but nothing pins the id of a new one.
		resumeIdCommand: "opencode --session",
		install: "curl -fsSL https://opencode.ai/install | bash",
		loginCommand: "opencode auth login",
		// `opencode run` takes the message as positional arguments.
		headless: { args: ["run"], prompt: "argv" },
	},
] as const satisfies readonly AgentDefinition[];

/** Build the launch command line for an agent (YOLO, resume, or agent-mode variants). */
export function agentCommand(
	agent: AgentDefinition,
	opts: {
		yolo?: boolean;
		resume?: boolean;
		agentMode?: boolean;
		/** Working dir to scope agent mode to (the task's worktree). */
		cwd?: string;
		prompt?: string;
		/** Id to pin a FRESH conversation to, so this tab can be resumed by name. */
		sessionId?: string;
		/** Resume THIS conversation — beats the cwd-scoped `resume`. */
		resumeSessionId?: string;
	} = {},
): string {
	// Agent mode launches the tool's own multi-agent board (interactive — it takes
	// the task description itself), so it ignores the prompt/resume variants. The
	// board is NOT scoped by the process cwd — it needs an explicit `--cwd` to
	// filter to this worktree (e.g. `claude agents --cwd <worktree>`).
	if (opts.agentMode && agent.agentsCommand) {
		const cwd = opts.cwd ? ` --cwd '${opts.cwd.replace(/'/g, `'\\''`)}'` : "";
		const base = `${agent.agentsCommand}${cwd}`;
		return opts.yolo && agent.yoloFlag ? `${base} ${agent.yoloFlag}` : base;
	}
	const sq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
	const resumeOne =
		opts.resumeSessionId && agent.resumeIdCommand
			? `${agent.resumeIdCommand} ${sq(opts.resumeSessionId)}`
			: null;
	const base =
		resumeOne ?? (opts.resume && agent.resumeCommand ? agent.resumeCommand : agent.command);
	let cmd = opts.yolo && agent.yoloFlag ? `${base} ${agent.yoloFlag}` : base;
	// Only a fresh launch takes an id: a resumed conversation already has one,
	// and handing it a second would either be refused or fork it in two.
	if (opts.sessionId && agent.sessionIdFlag && !resumeOne && !opts.resume) {
		cmd = `${cmd} ${agent.sessionIdFlag} ${sq(opts.sessionId)}`;
	}
	if (!opts.prompt) return cmd;
	// Single-quoted for the login shell; claude/codex take the prompt as a
	// positional argument, opencode via --prompt.
	const q = sq(opts.prompt);
	return agent.id === "opencode" ? `${cmd} --prompt ${q}` : `${cmd} ${q}`;
}

export type AgentId = (typeof AGENTS)[number]["id"];

export function getAgent(id: string): AgentDefinition | undefined {
	return AGENTS.find((a) => a.id === id);
}

/**
 * What a probe learned about a binary. "unknown" is not a synonym for absent:
 * it is the shell failing to answer, which must never be read as "this agent
 * is not installed" by anything that would then refuse to work.
 */
export type BinaryPresence = "present" | "absent" | "unknown";

/** The login shell a launch would use, when the caller doesn't name one. */
const defaultShell = (): string => process.env.SHELL || "/bin/zsh";

/**
 * Generous next to a measured ~0.14s (`zsh -lc` on a Mac with a real
 * .zprofile). A probe slower than this is a shell that cannot answer, and the
 * caller is better served by "unknown" than by waiting.
 */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Ask the LOGIN SHELL whether `bin` resolves.
 *
 * Deliberately the same shell and flags a launch uses — sessions.ts spawns
 * `$SHELL -l -c '<agent>; exec $SHELL -l'`, and the box installer verifies with
 * `bash -lc '<install> && command -v <bin>'`. Probing `/bin/sh` with this
 * process's own PATH instead would answer a different question: a GUI app on a
 * Mac inherits launchd's PATH, and when the boot-time probe misses (see the
 * three-layer fallback in login-env.ts) the dirs that `.zprofile` adds are
 * exactly the ones missing here. That gap produces a FALSE ABSENT, and a false
 * absent is what refuses a launch that would have worked.
 *
 * `bin` comes from this registry, never from user input, so it goes into the
 * command line as-is.
 */
export async function probeAgentBinary(
	bin: string,
	shell: string = defaultShell(),
): Promise<BinaryPresence> {
	try {
		await pexec(shell, ["-lc", `command -v ${bin}`], { timeout: PROBE_TIMEOUT_MS });
		return "present";
	} catch (err) {
		// Exit 1 is the shell answering "no such command" (POSIX `command -v`,
		// verified on zsh, bash and sh). Every other ending is the probe itself
		// failing: a timeout arrives as code null + killed, a missing shell as
		// ENOENT, neither of which knows anything about the binary.
		return (err as { code?: unknown }).code === 1 ? "absent" : "unknown";
	}
}

/** Installers download a runtime; the slow ones are minutes, not seconds. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/**
 * Run an agent's official installer on THIS machine.
 *
 * `&& command -v <bin>` is the acceptance test, not decoration: an installer
 * that unpacked a binary somewhere the login shell can't see has not installed
 * anything as far as this app is concerned, and saying otherwise would hand the
 * user a "done" that the next launch contradicts. Same command the box
 * installer has always run over SSH (host.ts), now available to whichever
 * machine the engine is on.
 *
 * Consent lives with the caller: engines run this only after a client relayed
 * the user's yes — the same rule `installCodeServer` states.
 */
export function installAgentCli(
	agent: AgentDefinition,
	shell: string = defaultShell(),
): Promise<void> {
	if (!agent.install) {
		return Promise.reject(new Error(`Don't know how to install ${agent.label}.`));
	}
	const cmd = `${agent.install} && command -v ${agent.bin}`;
	return new Promise((resolve, reject) => {
		execFile(shell, ["-lc", cmd], { timeout: INSTALL_TIMEOUT_MS }, (err, _out, stderr) => {
			if (!err) return resolve();
			// The installer's own last words are the only useful diagnostic here,
			// and they are what the user needs to see in the picker.
			const tail = (stderr ?? "").trim().split("\n").slice(-3).join(" ");
			reject(new Error(`Installing ${agent.label} failed${tail ? `: ${tail}` : ""}`));
		});
	});
}

/**
 * Is the agent's binary on PATH? Conservative on purpose: this answers "may I
 * OFFER this agent", where an unanswerable probe should hide it rather than
 * advertise something that may not run. The guard that REFUSES a launch asks
 * `probeAgentBinary` directly, so it can tell "no" apart from "don't know".
 */
export async function isAgentAvailable(bin: string, shell?: string): Promise<boolean> {
	return (await probeAgentBinary(bin, shell)) === "present";
}

export interface AvailableAgent extends AgentDefinition {
	available: boolean;
}

/** The registry annotated with which binaries are actually installed. */
export async function listAgents(): Promise<AvailableAgent[]> {
	return Promise.all(
		AGENTS.map(async (a) => ({
			...a,
			available: await isAgentAvailable(a.bin),
		})),
	);
}
