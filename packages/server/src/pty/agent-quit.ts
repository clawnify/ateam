/**
 * An agent that quit while its pane lives on.
 *
 * A pane runs `<agent>; notify AgentExit; exec $SHELL -l` (sessions.ts), so the
 * PTY outlives the agent by design and no PTY exit ever reports the agent's
 * end. Before the AgentExit call existed, such a session kept whatever status
 * its last hook left, often `awaiting_input` or `running`, for as long as the
 * shell stayed open: the card claimed an agent was waiting, the reaper (which
 * only takes `idle`) never reclaimed it, and Mission Control kept a tile of an
 * empty prompt for months.
 *
 * The session stays open, since the shell is real and may hold state, but it is
 * no longer an agent: `stopped` on a live PTY says exactly that, and nothing
 * else ever writes it while the PTY lives (the exit path runs once it is gone).
 * Mission Control drops such sessions and the card glyph draws a shell.
 */

import { type AgentSession, type AteamDb, repo, type Task } from "@ateam/db";
import type { KanbanColumn } from "@ateam/protocol";

/** Where a running card goes once its agent is gone: review if there is work to review. */
export function columnAfterExit(task: Task): KanbanColumn {
	return task.prNumber != null || (task.gitStatus?.ahead ?? 0) > 0 ? "review" : "needs_attention";
}

/**
 * Record that `session`'s agent quit. Returns the task id to announce, or null
 * when there is nothing to record.
 *
 * The task's status only follows when no other agent of the task is still at
 * work, and its column only leaves `running`, as on a PTY exit. Not marked
 * unread: quitting an agent is usually something the user just did.
 */
export function applyAgentQuit(
	db: AteamDb,
	pty: { has(terminalId: string): boolean },
	session: AgentSession,
): string | null {
	// A tab being closed or reaped kills the agent too, and that ending is the
	// PTY exit's to record.
	if (session.exitedAt != null || session.exitReason != null) return null;
	repo.updateSession(db, session.id, { status: "stopped" });
	const task = repo.getTask(db, session.taskId);
	if (!task) return null;
	const otherAgentAtWork = repo
		.listSessionsByTask(db, task.id)
		.some(
			(s) =>
				s.id !== session.id &&
				s.agentId !== "shell" &&
				s.status !== "stopped" &&
				pty.has(s.terminalId),
		);
	if (!otherAgentAtWork) {
		repo.updateTask(db, task.id, {
			agentStatus: "stopped",
			...(task.column === "running" ? { column: columnAfterExit(task) } : {}),
		});
	}
	return task.id;
}
