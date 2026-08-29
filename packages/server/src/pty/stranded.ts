/**
 * Which agent sessions the PTY daemon has forgotten.
 *
 * The daemon is detached and outlives the app (see daemon.ts), so an agent that
 * exits while the app is closed broadcasts its exit to nobody and is then
 * deleted from the daemon's session map. Nothing records it: the session keeps
 * `exitedAt: null` and its task sits in `running` forever — the board claims
 * agents are working when none are. The daemon hands us the authoritative live
 * set in `hello` on every connect (re-emitted by PtyClient as `attached`), so a
 * connect is exactly the moment to notice the exits we slept through.
 *
 * Deliberately scoped to sessions older than this engine process. A session row
 * is created BEFORE its spawn reaches the daemon (sessions.ts), so a respawned
 * daemon's first `hello` legitimately omits terminals that are about to start;
 * anything from this run is younger than `engineStartedAt` and is left alone.
 * Sessions started in this run get their exit from the live `exit` event, which
 * is the path that already works.
 *
 * Known gap: a daemon crash mid-run loses both the exit broadcast and these
 * sessions' eligibility here. Rare — a connected client keeps the daemon alive,
 * so it never idle-exits under a running app — and it self-heals on the next
 * app start, when those sessions are older than the new engine.
 *
 * Pure module: no db, no I/O, no clock. Unit-tested in test/stranded.test.ts.
 */

/** The fields of an open `agent_sessions` row this decision needs. */
export interface OpenSession {
	id: string;
	taskId: string;
	terminalId: string;
	startedAt: number | null;
}

/**
 * Open sessions whose terminal the daemon no longer knows about, restricted to
 * those predating this engine. Caller applies the exit each one missed.
 */
export function strandedSessions(
	open: readonly OpenSession[],
	liveTerminalIds: ReadonlySet<string>,
	engineStartedAt: number,
): OpenSession[] {
	return open.filter(
		(s) => !liveTerminalIds.has(s.terminalId) && (s.startedAt ?? 0) < engineStartedAt,
	);
}
