// Tabs for a task's terminals. A task can hold any number of live PTY sessions
// at once — several agents, a shell or two — and the engine already models that
// (agent_sessions is keyed by task, pty:listForTask returns every live one). So
// the tabs are not state of their own: they ARE the session list, and the only
// thing the panel decides is which one to look at. Pure + unit-tested.
//
// Restarting the machine kills the PTY daemon, and with it every terminal. The
// sessions that were open at that moment are marked `stranded` by the engine's
// reconcile and come back here as RESTORABLE tabs: they hold no process, they
// sit at the end of the strip, and clicking one spawns a terminal that resumes
// the same conversation. Everything else about a tab is unchanged.
import type { AgentDTO, SessionDTO } from "@ateam/protocol";

export interface SessionTab {
	session: SessionDTO;
	label: string;
	/** False for a tab with no process behind it — click to bring it back. */
	live: boolean;
}

/**
 * Label each session by its agent, numbering only from the second one of a kind
 * ("Claude", "Claude 2") so the common single-session case reads as a plain name.
 * `sessions` must be oldest-first, which keeps a tab's number stable for as long
 * as it lives — numbering the newest would renumber the whole strip on each spawn.
 *
 * Restorable tabs are numbered in the same sequence and follow the live ones, so
 * bringing one back never renumbers a tab you are looking at.
 */
export function sessionTabs(
	sessions: SessionDTO[],
	agents: AgentDTO[],
	restorable: SessionDTO[] = [],
): SessionTab[] {
	const seen = new Map<string, number>();
	const label = (session: SessionDTO): string => {
		const base =
			session.agentId === "shell"
				? "Shell"
				: (agents.find((a) => a.id === session.agentId)?.label ?? session.agentId);
		const n = (seen.get(base) ?? 0) + 1;
		seen.set(base, n);
		return n > 1 ? `${base} ${n}` : base;
	};
	return [
		...sessions.map((session) => ({ session, label: label(session), live: true })),
		...restorable.map((session) => ({ session, label: label(session), live: false })),
	];
}

/**
 * Which session a view should be showing, given the live (oldest-first) list and
 * the tab currently picked. Keeps your pick while it's alive. When it dies, or
 * when a task is opened with sessions this view has never chosen between, it
 * falls to the newest AGENT session, and only to a plain shell when the task has
 * no agent at all: a terminal you opened to run one command is not what the task
 * is about, so it should not become what you see just by being newest. `null`
 * means the task has no terminal left.
 */
export function activeTerminal(sessions: SessionDTO[], current: string | null): string | null {
	if (current && sessions.some((s) => s.terminalId === current)) return current;
	const agents = sessions.filter((s) => s.agentId !== "shell");
	const pool = agents.length ? agents : sessions;
	return pool[pool.length - 1]?.terminalId ?? null;
}
