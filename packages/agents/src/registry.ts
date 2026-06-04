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
	/** How an initial task prompt is delivered (if supported). */
	promptTransport?: PromptTransport;
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
		yoloFlag: "--dangerously-skip-permissions",
		resumeCommand: "claude --continue",
	},
	{
		id: "codex",
		label: "Codex",
		description:
			"OpenAI's coding agent for reading, modifying, and running code across tasks.",
		bin: "codex",
		command: "codex",
		yoloFlag: "--dangerously-bypass-approvals-and-sandbox",
		resumeCommand: "codex resume --last",
	},
	{
		id: "opencode",
		label: "OpenCode",
		description: "Open-source coding agent for the terminal, IDE, and desktop.",
		bin: "opencode",
		command: "opencode",
		resumeCommand: "opencode --continue",
	},
] as const satisfies readonly AgentDefinition[];

/** Build the launch command line for an agent (YOLO and/or resume variants). */
export function agentCommand(
	agent: AgentDefinition,
	opts: { yolo?: boolean; resume?: boolean; prompt?: string } = {},
): string {
	const base =
		opts.resume && agent.resumeCommand ? agent.resumeCommand : agent.command;
	const cmd = opts.yolo && agent.yoloFlag ? `${base} ${agent.yoloFlag}` : base;
	if (!opts.prompt) return cmd;
	// Single-quoted for the login shell; claude/codex take the prompt as a
	// positional argument, opencode via --prompt.
	const q = `'${opts.prompt.replace(/'/g, `'\\''`)}'`;
	return agent.id === "opencode" ? `${cmd} --prompt ${q}` : `${cmd} ${q}`;
}

export type AgentId = (typeof AGENTS)[number]["id"];

export function getAgent(id: string): AgentDefinition | undefined {
	return AGENTS.find((a) => a.id === id);
}

/** Is the agent's binary on PATH? */
export async function isAgentAvailable(bin: string): Promise<boolean> {
	try {
		await pexec("command", ["-v", bin], { shell: "/bin/sh" });
		return true;
	} catch {
		try {
			await pexec("which", [bin]);
			return true;
		} catch {
			return false;
		}
	}
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
