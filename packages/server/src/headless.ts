/**
 * One headless turn on an agent CLI, for the engine's own small text jobs:
 * session search's re-rank, and titles, tags and summaries when Claude Code
 * writes them (text-model.ts). Each agent's registry entry says how to call it
 * non-interactively (`headless`); for Claude that is `-p --safe-mode
 * --restricted`, which loads none of the user's customizations and has no tool
 * that runs commands.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgent } from "@ateam/agents";

/** The user's login shell, which every agent launch goes through. */
export const shell = process.env.SHELL || "/bin/zsh";

/** How long the model gets before the caller falls back to having no answer. */
const TIMEOUT_MS = 45_000;

/** Quote one argument for the login shell. */
function q(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run one headless turn on `agentId`. Resolves to "" on any failure: the
 * caller treats an empty reply as "no opinion" and keeps its own fallback.
 *
 * Launched through a LOGIN shell, exactly as an interactive agent session is
 * (see sessions.ts). A GUI app inherits launchd's PATH, not the user's, so a
 * bare spawn of `claude` fails with ENOENT on a Mac whenever the boot-time PATH
 * probe did not land. That failure would be invisible here, quietly
 * downgrading every AI search to a lexical one.
 *
 * It runs in a temp dir: no job here is about the engine's own working
 * directory, and an agent started in one reads that directory's AGENTS.md.
 */
export function askAgent(agentId: string, prompt: string, timeoutMs = TIMEOUT_MS): Promise<string> {
	const agent = getAgent(agentId);
	if (!agent?.headless) return Promise.resolve("");
	const { args, prompt: transport, lastMessageFlag } = agent.headless;
	const dir = lastMessageFlag ? mkdtempSync(join(tmpdir(), "ateam-headless-")) : null;
	const outFile = dir ? join(dir, "answer.txt") : null;
	const cmdline = [
		agent.bin,
		...args,
		...(lastMessageFlag && outFile ? [lastMessageFlag, q(outFile)] : []),
		...(transport === "argv" ? [q(prompt)] : []),
	].join(" ");
	return new Promise<string>((resolve) => {
		let done = false;
		const finish = (text: string) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			if (dir) rmSync(dir, { recursive: true, force: true });
			resolve(text);
		};
		const child = spawn(shell, ["-lc", cmdline], {
			cwd: tmpdir(),
			stdio: ["pipe", "pipe", "ignore"],
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish("");
		}, timeoutMs);
		let stdout = "";
		child.stdout.on("data", (d: Buffer) => {
			// A runaway reply is a broken call, not an answer worth buffering.
			if (stdout.length < 200_000) stdout += d.toString();
		});
		child.on("error", () => finish(""));
		child.on("close", (code) => {
			if (code !== 0) return finish("");
			if (!outFile) return finish(stdout);
			try {
				finish(readFileSync(outFile, "utf8"));
			} catch {
				finish(stdout);
			}
		});
		if (transport === "stdin") {
			child.stdin.end(prompt);
		} else {
			child.stdin.end();
		}
	});
}
