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
 *  - An agent someone typed into since it last reported (holdsWork). Codex in
 *    a worktree whose hooks it was never asked to trust reports only the end of
 *    a turn, so a prompt typed into it leaves it `idle` while it works; the
 *    sweep would otherwise kill that turn once its previous Stop is old enough.
 *  - Anything quiet for less than the idle window, counted from its last event,
 *    or from its launch when it has reported none. Rows are created with the
 *    default `idle` status BEFORE the agent starts (sessions.ts), so a session
 *    with no event may simply have just started. But a Codex resumed with no
 *    prompt reports nothing until it finishes a turn, so one nobody ever types
 *    into (a tab a client restored on its own) would otherwise live forever.
 *  - An agent Ateam never hears from (SILENT) that has not reported an event:
 *    with no event ever, there is nothing to tell an idle one from a busy one.
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
	/** When the row was written, just before its agent was launched. */
	startedAt: number | null;
	/** When a viewer last typed into its terminal, this engine run. */
	lastInputAt: number | null;
}

/**
 * Agents that report no hook events at all. OpenCode is handed messages by its
 * own plugin (peer-messages.ts), so it can be mid-turn with no event and no
 * keystroke to show for it: its launch time says nothing about whether it is
 * idle.
 */
const SILENT = new Set(["opencode"]);

/** A human typed this recently: never restart or reap under their hands. */
export const INPUT_QUIET_MS = 60 * 1000;

/**
 * Killing this agent would throw work away: it is busy, or someone typed into
 * it. Shared by the peer messenger (a restart) and the reaper (a kill).
 */
export function holdsWork(
	status: string,
	lastInputAt: number | null,
	lastEventAt: number | null,
	now: number,
): boolean {
	// Mid-turn or holding a question: it is busy, and a restart would throw the
	// turn away. Its Stop brings us back here.
	if (status !== "idle") return true;
	if (lastInputAt == null) return false;
	if (now - lastInputAt < INPUT_QUIET_MS) return true;
	// Typed into since its turn ended: a prompt it is now working on (Codex
	// reports no turn start without its trusted hooks) or a draft. Either way
	// the status is stale; its next Stop brings us back.
	return lastEventAt == null || lastInputAt > lastEventAt;
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
	return open.filter((s) => {
		if (s.agentId === "shell") return false;
		const quietSince = s.lastEventAt ?? (SILENT.has(s.agentId) ? null : s.startedAt);
		if (quietSince == null || now - quietSince < idleMs) return false;
		return !holdsWork(s.status, s.lastInputAt, quietSince, now);
	});
}
