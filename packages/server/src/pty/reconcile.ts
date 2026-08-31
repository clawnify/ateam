/**
 * What happens to a task's sessions when the PTY daemon reconnects.
 *
 * Two jobs, and the ORDER between them is the whole point:
 *
 *  1. Retire the PREVIOUS run's stranded sessions. `stranded` means "was open
 *     when the app last went down", which is what the panel offers back as
 *     restorable tabs. A tab you did not bring back during an entire run of the
 *     app is history, not a tab — without this step every run would leave its
 *     own layer of ghosts behind on the strip.
 *  2. Mark THIS run's: the open sessions the daemon no longer knows about
 *     (`strandedSessions`), whose exits nobody was around to hear.
 *
 * Run (1) before (2) and only on the first connect of a run, or a mid-run
 * reconnect would throw away tabs this run has not yet had the chance to
 * restore. Kept out of `stranded.ts`, which is pure by design, and out of the
 * engine, so both halves can be tested against a real db.
 */
import { type AgentSession, type AteamDb, repo } from "@ateam/db";
import { type OpenSession, strandedSessions } from "./stranded";

/** Apply the exit a stranded session missed (column, status, timestamps). */
export type ApplyStrandedExit = (session: OpenSession) => void;

/**
 * Build the once-per-run reconciler. Call the result with the daemon's live
 * terminal set on every connect; it returns the sessions it stranded, for the
 * caller to log.
 */
export function makeStrandReconciler(
	db: AteamDb,
	engineStartedAt: number,
	applyExit: ApplyStrandedExit,
): (liveTerminalIds: ReadonlySet<string>) => OpenSession[] {
	let sweptOnce = false;
	return (liveTerminalIds) => {
		if (!sweptOnce) {
			repo.demoteStrandedSessions(db);
			sweptOnce = true;
		}
		const open: OpenSession[] = repo.listOpenSessions(db).map((s: AgentSession) => ({
			id: s.id,
			taskId: s.taskId,
			terminalId: s.terminalId,
			startedAt: s.startedAt,
		}));
		const stranded = strandedSessions(open, liveTerminalIds, engineStartedAt);
		for (const s of stranded) applyExit(s);
		return stranded;
	};
}
