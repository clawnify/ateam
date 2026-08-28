// Tabs for a task's terminals. A task can hold any number of live PTY sessions
// at once — several agents, a shell or two — and the engine already models that
// (agent_sessions is keyed by task, pty:listForTask returns every live one). So
// the tabs are not state of their own: they ARE the session list, and the only
// thing the panel decides is which one to look at. Pure + unit-tested.
import type { AgentDTO, SessionDTO } from "@ateam/protocol";

export interface SessionTab {
	session: SessionDTO;
	label: string;
}

/**
 * Label each session by its agent, numbering only from the second one of a kind
 * ("Claude", "Claude 2") so the common single-session case reads as a plain name.
 * `sessions` must be oldest-first, which keeps a tab's number stable for as long
 * as it lives — numbering the newest would renumber the whole strip on each spawn.
 */
export function sessionTabs(sessions: SessionDTO[], agents: AgentDTO[]): SessionTab[] {
	const seen = new Map<string, number>();
	return sessions.map((session) => {
		const base =
			session.agentId === "shell"
				? "Shell"
				: (agents.find((a) => a.id === session.agentId)?.label ?? session.agentId);
		const n = (seen.get(base) ?? 0) + 1;
		seen.set(base, n);
		return { session, label: n > 1 ? `${base} ${n}` : base };
	});
}

/**
 * Which session the panel should be showing, given the live (oldest-first) list
 * and the tab currently picked. Keeps your pick while it's alive; when it dies —
 * or when a task is opened with sessions this window has never chosen between —
 * falls to the newest survivor. `null` means the task has no terminal left.
 */
export function activeTerminal(sessions: SessionDTO[], current: string | null): string | null {
	if (current && sessions.some((s) => s.terminalId === current)) return current;
	return sessions[sessions.length - 1]?.terminalId ?? null;
}
