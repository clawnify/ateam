/**
 * Did each agent Ateam launched actually load the board tools?
 *
 * Ateam never installs its board MCP server into an agent's own config: every
 * launch passes it (Claude `--mcp-config`, Codex `-c mcp_servers.*`, OpenCode
 * `OPENCODE_CONFIG_CONTENT`; see sessions.ts), so an agent the user already had
 * set up gets it with nothing to install. What a launch can't promise is that
 * the agent took it: an organization policy can drop the server without a word
 * (Claude's allowedMcpServers / deniedMcpServers), an old CLI can ignore the
 * config or the token header, and an agent the user re-runs by hand in a pane
 * whose agent quit gets the worktree's hooks but none of the launch flags.
 * Each of those agents looks alive on the board while ask_user, send_message,
 * show_page and the proposals are missing, and nothing says so.
 *
 * So the board's own endpoint is the witness. Every agent connects to its MCP
 * servers as it starts (measured on Claude 2.1.319, Codex 0.167 and OpenCode
 * 1.18: `initialize` within seconds, before any prompt), and every request it
 * sends carries its terminal id and token. An agent that has shown signs of
 * life (a hook event, or its inbox listener polling, which is OpenCode's only
 * sign) and sent no verified request for GRACE_MS after that never got the
 * tools. Only a verified request counts: one without the token is answered,
 * but the board refuses that caller every tool that matters (board-mcp.ts).
 *
 * In memory on purpose, like the seeds behind TaskDTO.preparing. Agents outlive
 * an engine restart and do not connect again, so a record kept across one
 * would say nothing new, and an agent this engine did not launch (or see quit)
 * is simply never judged. Agent mode (`claude agents`) gets no board tools by
 * design, so it is never launched into this either.
 */

/** How long an agent that is up may go without reaching the board. */
export const BOARD_GRACE_MS = 60_000;

/** A session that should have the board tools and does not. */
export interface BoardToolsMissing {
	/** The agent Ateam launched in the pane. */
	agentId: string;
	/** The agent in the pane now was started by hand after Ateam's quit. */
	byHand: boolean;
}

interface Entry {
	taskId: string;
	agentId: string;
	/** No agent of Ateam's runs in the pane: its agent quit and the pane is a
	 *  shell. The next sign of life is an agent someone started there by hand. */
	exited: boolean;
	byHand: boolean;
	upAt: number | null;
	seenAt: number | null;
	missing: boolean;
	timer: ReturnType<typeof setTimeout> | null;
}

export interface BoardConnectionDeps {
	/** A task's answer changed: announce it (engine `sendTaskUpdated`). */
	onChange: (taskId: string) => void;
	now?: () => number;
	graceMs?: number;
}

export class BoardConnections {
	private readonly entries = new Map<string, Entry>();
	private readonly now: () => number;
	private readonly graceMs: number;

	constructor(private readonly deps: BoardConnectionDeps) {
		this.now = deps.now ?? Date.now;
		this.graceMs = deps.graceMs ?? BOARD_GRACE_MS;
	}

	/**
	 * Ateam started an agent that carries the board tools in this pane. That is
	 * what a started-by-hand note asks for, so the task's other started-by-hand
	 * panes go back to being shells: nothing reports such an agent quitting (it
	 * is not on Ateam's launch line, so no AgentExit), and the note would
	 * otherwise outlive the advice being followed. One still in use speaks again
	 * through its hooks and is judged afresh.
	 */
	launched(terminalId: string, taskId: string, agentId: string): void {
		for (const e of this.entries.values()) {
			if (e.taskId !== taskId || !e.byHand) continue;
			this.clearTimer(e);
			Object.assign(e, { exited: true, byHand: false, upAt: null, seenAt: null, missing: false });
		}
		this.drop(terminalId);
		this.entries.set(terminalId, {
			taskId,
			agentId,
			exited: false,
			byHand: false,
			upAt: null,
			seenAt: null,
			missing: false,
			timer: null,
		});
	}

	/** The pane's agent sent the board a request with its own valid token. */
	seen(terminalId: string): void {
		const e = this.entries.get(terminalId);
		if (!e || e.exited) return;
		e.seenAt = this.now();
		this.clearTimer(e);
		if (e.missing) {
			e.missing = false;
			this.deps.onChange(e.taskId);
		}
	}

	/**
	 * A sign of life from the pane's agent: a hook event, or (`fromHook` false)
	 * its inbox listener polling. Only a hook event can mean an agent started by
	 * hand after Ateam's quit: a listener is a process of its own and may poll on
	 * a little after its agent is gone, so it never reopens a quit pane.
	 */
	up(terminalId: string, fromHook = true): void {
		const e = this.entries.get(terminalId);
		if (!e) return;
		if (e.exited) {
			if (!fromHook) return;
			// Ateam's agent quit, so this one was started by hand in the shell
			// that took its place: it got the hooks but no launch flags.
			e.exited = false;
			e.byHand = true;
			e.seenAt = null;
			e.upAt = null;
		}
		if (e.upAt != null) return;
		e.upAt = this.now();
		if (e.seenAt != null) return;
		e.timer = setTimeout(() => this.judge(terminalId), this.graceMs);
	}

	/** The pane's agent quit and the pane lives on as a shell. */
	quit(terminalId: string, taskId: string, agentId: string): void {
		const e = this.entries.get(terminalId);
		if (!e) {
			// One this engine did not launch (it predates a restart): from here on
			// it is known, so an agent re-run there by hand is judged.
			this.entries.set(terminalId, {
				taskId,
				agentId,
				exited: true,
				byHand: false,
				upAt: null,
				seenAt: null,
				missing: false,
				timer: null,
			});
			return;
		}
		this.clearTimer(e);
		e.exited = true;
		e.upAt = null;
		e.seenAt = null;
		if (e.missing) {
			e.missing = false;
			this.deps.onChange(e.taskId);
		}
	}

	/** The pane is gone. */
	gone(terminalId: string): void {
		this.drop(terminalId);
	}

	/**
	 * The first pane of `taskId` whose agent is known to lack the board tools.
	 * Asked on every task broadcast, so it reads only this map: a few entries
	 * per live pane, no database.
	 */
	missingIn(taskId: string, isLive: (terminalId: string) => boolean): BoardToolsMissing | null {
		for (const [terminalId, e] of this.entries) {
			if (e.missing && e.taskId === taskId && isLive(terminalId)) {
				return { agentId: e.agentId, byHand: e.byHand };
			}
		}
		return null;
	}

	stop(): void {
		for (const e of this.entries.values()) this.clearTimer(e);
		this.entries.clear();
	}

	private judge(terminalId: string): void {
		const e = this.entries.get(terminalId);
		if (!e) return;
		e.timer = null;
		if (e.exited || e.seenAt != null || e.missing) return;
		e.missing = true;
		this.deps.onChange(e.taskId);
	}

	private drop(terminalId: string): void {
		const e = this.entries.get(terminalId);
		if (!e) return;
		this.clearTimer(e);
		this.entries.delete(terminalId);
	}

	private clearTimer(e: Entry): void {
		if (e.timer) clearTimeout(e.timer);
		e.timer = null;
	}
}

/**
 * The sentence a task shows for a session without the board tools
 * (TaskDTO.boardToolsMissing). What each agent most likely needs: an
 * organization policy is the one known way to drop Claude's server, and an old
 * CLI the likeliest for the others.
 */
export function boardToolsSentence(m: BoardToolsMissing, agentLabel: string): string {
	const lacks = "so it can't ask you here, message other tasks or show you pages";
	if (m.byHand) {
		return `The agent started by hand in this task's terminal has no board tools, ${lacks}. Quit it and start it again from Ateam to get them.`;
	}
	if (m.agentId === "claude") {
		return `${agentLabel} didn't load Ateam's board tools, ${lacks}. An organization policy on MCP servers does this: an admin can allow http://127.0.0.1:*/* in allowedMcpServers. Then restart the agent from Ateam.`;
	}
	return `${agentLabel} didn't load Ateam's board tools, ${lacks}. An older ${agentLabel} can do this: update it, then restart the agent from Ateam.`;
}
