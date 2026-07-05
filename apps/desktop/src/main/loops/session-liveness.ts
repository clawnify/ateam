import type { AgentSession, AteamDb } from "@ateam/db";
import { repo } from "@ateam/db";

/**
 * Is an agent process still running? Shared by the board reconciler and the
 * board organizer's signal-gathering — both need the same ground-truth answer
 * to "does a live agent own this card?".
 *
 * pid-first because the PTY exit path doesn't always write `exitedAt`, so a
 * killed agent can sit in the DB as "running" forever; pid liveness catches
 * exactly that. `EPERM` means the pid exists but isn't ours — still alive.
 */
export function pidAlive(pid: number | null | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** A session is live if its pid runs; older sessions with no pid fall back to flags. */
export function sessionAlive(s: AgentSession): boolean {
	if (s.pid != null) return pidAlive(s.pid);
	return s.exitedAt == null && s.status !== "stopped";
}

/** Does any session for this task have a live agent process? */
export function agentAlive(db: AteamDb, taskId: string): boolean {
	return repo.listSessionsByTask(db, taskId).some(sessionAlive);
}
