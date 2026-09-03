/**
 * Which idle agent sessions the app reclaims.
 *
 * A finished agent is not free. It sits at its prompt holding a full harness
 * heap — hundreds of MB for Claude Code — and producing nothing, and nothing
 * ever closes it: a PTY dies only when you close its tab (dispatcher's
 * `ptyKill`) or delete the task. Over a few days of work that is dozens of
 * processes and gigabytes of RAM held for conversations nobody is having, with
 * no ceiling other than how many tasks you have started.
 *
 * Reclaiming one costs little, because the process is not where the
 * conversation lives: the harness writes its transcript to disk as it works and
 * resumes from there. So a reaped session becomes a restorable tab — the same
 * affordance the app already offers for sessions stranded by a crash — and
 * bringing it back resumes THAT conversation (see dispatcher's
 * `ptyRestoreSession`).
 *
 * What is deliberately never reaped:
 *
 *  - Anything but `idle`. `idle` is set by a Stop event, i.e. the turn is
 *    complete and nothing is in flight. `running` may be mid-tool-call and
 *    `awaiting_input` is holding a question; killing either throws away work in
 *    progress, which is exactly what closing such a tab warns about first.
 *  - A session that has never reported an event. Rows are created with the
 *    default `idle` status BEFORE the agent starts (sessions.ts), so a null
 *    `lastEventAt` means "not started yet", not "finished long ago". Without
 *    this guard the sweep would kill every agent it just launched.
 *  - Shells. A shell holds state that exists nowhere else — its cwd, its env, a
 *    half-typed command — and has no transcript to resume from.
 *
 * Pure module: no db, no I/O, no clock. Unit-tested in test/reap.test.ts.
 */

/** The fields of an open `agent_sessions` row this decision needs. */
export interface ReapableSession {
	id: string;
	taskId: string;
	terminalId: string;
	agentId: string;
	status: string;
	lastEventAt: number | null;
}

/**
 * Open sessions that finished their turn and have been quiet for at least
 * `idleMs`. Caller stamps the ending and kills the PTY.
 */
export function reapableSessions<T extends ReapableSession>(
	open: readonly T[],
	now: number,
	idleMs: number,
): T[] {
	return open.filter(
		(s) =>
			s.status === "idle" &&
			s.agentId !== "shell" &&
			s.lastEventAt != null &&
			now - s.lastEventAt >= idleMs,
	);
}
