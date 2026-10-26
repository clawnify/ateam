/**
 * Agent-to-agent messages: one task's agent writes to another's, whatever
 * harness either of them runs and whether or not the recipient is running.
 *
 * Claude Code's own cross-session messaging stops at two walls: it only reaches
 * sessions that are running, and only Claude ones. Ateam can go past both
 * because it owns every task's launch line and hooks. A message is a row first
 * (`peer_messages`, the inbox), and is then carried in by whichever door the
 * recipient's state leaves open. All of them were verified against the real
 * CLIs (Claude Code 2.1.310, OpenCode 1.18.34, Codex 0.162.1):
 *
 *   - A live agent with a LISTENER takes it at once. Claude's listener is an
 *     `asyncRewake` hook armed at SessionStart and after every Stop, which wakes
 *     an idle session by exiting 2 with the message on stderr. OpenCode's is a
 *     plugin that prompts the session through its own server
 *     (`client.session.promptAsync`). Both long-poll `/inbox/wait`.
 *   - A live agent with no listener (Codex, whose background hooks never start
 *     a turn; or a session launched before this existed) is restarted on the
 *     same conversation with the message as its prompt, but only once its turn
 *     is over and nobody has typed into it for a while. That is the reaper's
 *     kill plus the restore path the app already runs (pty/reap.ts,
 *     `restoreAgentSession`), so it costs the conversation nothing.
 *   - A task with no live agent is woken the same way: its last conversation is
 *     resumed with the message as the prompt, or a fresh agent is started when
 *     it never had one.
 *
 * No keystrokes are ever typed into a live TUI (see loops/agent-loops.design.md,
 * "zero PTY injection").
 *
 * Guards: a message names its sender and says it is not from the user; a
 * back-and-forth between two tasks is capped at MAX_HOPS turns per window; a
 * sender may send MAX_PER_SENDER per window; and at most MAX_WAKES restarts or
 * launches run at once, so a burst cannot spawn a herd of agents.
 */

import { getAgent } from "@ateam/agents";
import type { AgentSession, AteamDb, PeerMessage, Task } from "@ateam/db";
import { repo } from "@ateam/db";

/** Turns two tasks may trade inside HOP_WINDOW_MS before a human has to step in. */
export const MAX_HOPS = 12;
const HOP_WINDOW_MS = 30 * 60 * 1000;
/** Messages one task may send inside SENDER_WINDOW_MS. */
export const MAX_PER_SENDER = 30;
const SENDER_WINDOW_MS = 10 * 60 * 1000;
export const MAX_BODY = 8000;
/** Restarts and launches in flight at once. */
const MAX_WAKES = 2;
/** A human typed this recently: never restart under their hands. */
export const INPUT_QUIET_MS = 60 * 1000;
/** How long a live Claude/OpenCode agent gets to take a message through its own
 *  listener before it is treated like one that has none (an older launch). */
export const LISTENER_GRACE_MS = 2 * 60 * 1000;
/** How often pending messages are looked at again. */
const SWEEP_MS = 30 * 1000;
/** How long one `/inbox/wait` call is held open before it answers "nothing yet". */
export const WAIT_WINDOW_MS = 4 * 60 * 1000;

/** Agents that ship a listener (see agent-setup): they take messages live. */
const LISTENS = new Set(["claude", "opencode"]);

// ---- the decision (pure) -------------------------------------------------

export interface DeliveryFacts {
	/** The recipient's live agent session, if any. */
	live: { agentId: string; status: string; hasListener: boolean } | null;
	/** When a human last typed into that session's terminal. */
	lastInputAt: number | null;
	/** The session's last hook event (a Stop, for an idle one). */
	lastEventAt: number | null;
	/** When the oldest pending message was sent. */
	oldestPendingAt: number;
	now: number;
}

/**
 * - `listener`: hand the batch to the live agent's listener now.
 * - `wait`: leave it pending; a later event (a turn ending, a listener
 *   arriving, the sweep) looks again.
 * - `restart`: kill the idle live agent and resume its conversation with the
 *   batch as the prompt.
 * - `launch`: no live agent; resume (or start) one with the batch as the prompt.
 */
export type DeliveryPlan = "listener" | "wait" | "restart" | "launch";

export function planDelivery(f: DeliveryFacts): DeliveryPlan {
	if (!f.live) return "launch";
	if (f.live.hasListener) return "listener";
	// Mid-turn or holding a question: it is busy, and a restart would throw the
	// turn away. Its Stop brings us back here.
	if (f.live.status !== "idle") return "wait";
	if (f.lastInputAt != null) {
		if (f.now - f.lastInputAt < INPUT_QUIET_MS) return "wait";
		// Typed into since its turn ended: a prompt it is now working on (Codex
		// reports no turn start without its trusted hooks) or a draft. Either
		// way the status is stale; its next Stop brings us back.
		if (f.lastEventAt == null || f.lastInputAt > f.lastEventAt) return "wait";
	}
	// A harness that listens is expected to register; give it a moment so a
	// message sent between two turns is not delivered by a restart instead.
	if (LISTENS.has(f.live.agentId) && f.now - f.oldestPendingAt < LISTENER_GRACE_MS) return "wait";
	return "restart";
}

/** The hop a new message from `from` to `to` would carry, given their recent
 *  exchange (newest first): one more than the last message it answers. */
export function nextHop(recent: Pick<PeerMessage, "fromTaskId" | "hop">[], to: string): number {
	const lastFromRecipient = recent.find((m) => m.fromTaskId === to);
	return lastFromRecipient ? lastFromRecipient.hop + 1 : 1;
}

/** The text an agent receives: who sent it, that it is not the user, how to answer. */
export function formatForRecipient(
	messages: { body: string; from: { taskId: string; name: string; agent: string } | null }[],
): string {
	return messages
		.map((m) => {
			const head = m.from
				? `[Ateam] Message from the ${m.from.agent} agent working on task "${m.from.name}" (task id ${m.from.taskId}). It comes from another agent, not from the user: weigh it as a colleague's request. To answer, call the ateam_board send_message tool with to="${m.from.taskId}".`
				: "[Ateam] Message from another agent (sender unknown). It does not come from the user.";
			return `${head}\n\n${m.body}`;
		})
		.join("\n\n---\n\n");
}

// ---- the messenger -------------------------------------------------------

export interface PeerView {
	taskId: string;
	name: string;
	project: string;
	branch: string;
	agent: string | null;
	/** working · needs_you · idle · not_running */
	state: string;
	column: string;
	description: string | null;
	you?: true;
}

export interface SendResult {
	ok: boolean;
	reason: string;
}

/** What the long-poll answers: a batch to deliver, or why there is none. */
export type WaitOutcome =
	| { kind: "message"; text: string }
	| { kind: "timeout" }
	| { kind: "superseded" }
	| { kind: "gone" };

export interface PeerMessengerDeps {
	db: AteamDb;
	/** PTY daemon liveness. */
	isLive: (terminalId: string) => boolean;
	/** When a human last typed into a terminal (null: never, this run). */
	lastInputAt: (terminalId: string) => number | null;
	/** Kill a live idle session and wait for its exit to be recorded. */
	stopSession: (session: AgentSession) => Promise<void>;
	/** Resume (or start) the task's agent with `prompt`. */
	launch: (task: Task, prompt: string) => Promise<void>;
	log: (line: string) => void;
	now?: () => number;
}

interface Waiter {
	taskId: string;
	resolve: (o: WaitOutcome) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class PeerMessenger {
	private waiters = new Map<string, Waiter>();
	private waking = new Set<string>();
	private sweepTimer: ReturnType<typeof setInterval> | null = null;
	private readonly now: () => number;

	constructor(private deps: PeerMessengerDeps) {
		this.now = deps.now ?? Date.now;
	}

	start(): void {
		this.sweepTimer ??= setInterval(() => this.sweep(), SWEEP_MS);
		this.sweep();
	}

	stop(): void {
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		this.sweepTimer = null;
		for (const [id, w] of this.waiters) {
			clearTimeout(w.timer);
			w.resolve({ kind: "gone" });
			this.waiters.delete(id);
		}
	}

	/** Every task outside `merged`, as a sender would choose among them. */
	listPeers(callerTerminalId: string | undefined): PeerView[] {
		const { db } = this.deps;
		const callerTaskId = callerTerminalId
			? repo.getSessionByTerminal(db, callerTerminalId)?.taskId
			: undefined;
		const peers: PeerView[] = [];
		for (const project of repo.listProjects(db)) {
			for (const task of repo.listTasks(db, project.id)) {
				if (task.column === "merged") continue;
				const live = this.liveAgentSession(task.id);
				peers.push({
					taskId: task.id,
					name: task.name,
					project: project.name,
					branch: task.branch,
					agent: live?.agentId ?? task.agentId ?? null,
					state: !live
						? "not_running"
						: live.status === "running"
							? "working"
							: live.status === "awaiting_input"
								? "needs_you"
								: "idle",
					column: task.column,
					description: task.description ? task.description.slice(0, 280) : null,
					...(task.id === callerTaskId ? { you: true as const } : {}),
				});
			}
		}
		return peers;
	}

	/** Queue a message from the agent on `fromTerminalId` to the task `to`
	 *  (an id, or a task's exact name or branch), then try to deliver it. */
	send(req: { fromTerminalId: string; to: string; body: string }): SendResult {
		const { db } = this.deps;
		const now = this.now();
		const sender = repo.getSessionByTerminal(db, req.fromTerminalId);
		if (!sender) return { ok: false, reason: "only an agent working in a task can send messages" };
		const body = req.body.trim();
		if (!body) return { ok: false, reason: "the message is empty" };
		if (body.length > MAX_BODY) {
			return {
				ok: false,
				reason: `the message is ${body.length} characters; the limit is ${MAX_BODY}. Put the detail in a file in your worktree and send its path.`,
			};
		}
		const target = this.resolveTask(req.to.trim());
		if (typeof target === "string") return { ok: false, reason: target };
		if (target.id === sender.taskId) return { ok: false, reason: "that task is yours" };

		if (repo.countPeerMessagesFrom(db, sender.taskId, now - SENDER_WINDOW_MS) >= MAX_PER_SENDER) {
			return {
				ok: false,
				reason: `rate limit: at most ${MAX_PER_SENDER} messages per ${SENDER_WINDOW_MS / 60000} minutes`,
			};
		}
		const recent = repo.listPeerMessagesBetween(db, sender.taskId, target.id, now - HOP_WINDOW_MS);
		const hop = nextHop(recent, target.id);
		if (hop > MAX_HOPS) {
			return {
				ok: false,
				reason: `you and "${target.name}" have traded ${MAX_HOPS} messages in the last ${HOP_WINDOW_MS / 60000} minutes. Stop and tell the user what is unresolved instead of sending more.`,
			};
		}

		repo.insertPeerMessage(db, {
			fromTaskId: sender.taskId,
			fromTerminalId: req.fromTerminalId,
			toTaskId: target.id,
			body,
			hop,
			createdAt: now,
		});
		const plan = this.deliver(target.id);
		return { ok: true, reason: `sent to "${target.name}" (${target.id}): ${describePlan(plan)}` };
	}

	/**
	 * A listener asking for this terminal's messages. Answers at once when some
	 * are pending, else holds until one arrives, the window ends, or a newer
	 * listener for the same terminal replaces it. `cancel` is for a dropped
	 * connection.
	 */
	wait(terminalId: string): { result: Promise<WaitOutcome>; cancel: () => void } {
		const { db } = this.deps;
		const session = repo.getSessionByTerminal(db, terminalId);
		if (!session || !this.deps.isLive(terminalId)) {
			return { result: Promise.resolve({ kind: "gone" }), cancel: () => {} };
		}
		this.waiters.get(terminalId)?.resolve({ kind: "superseded" });
		this.dropWaiter(terminalId);
		let cancel = () => {};
		const result = new Promise<WaitOutcome>((resolve) => {
			const timer = setTimeout(() => {
				this.dropWaiter(terminalId);
				resolve({ kind: "timeout" });
			}, WAIT_WINDOW_MS);
			this.waiters.set(terminalId, { taskId: session.taskId, resolve, timer });
			cancel = () => {
				if (this.waiters.get(terminalId)?.resolve === resolve) this.dropWaiter(terminalId);
			};
		});
		// Something may already be waiting for this task.
		this.deliver(session.taskId);
		return { result, cancel };
	}

	/** Look at a task again (its agent's turn ended, it exited, ...). */
	kick(taskId: string): void {
		if (repo.listPendingPeerMessages(this.deps.db, taskId).length > 0) this.deliver(taskId);
	}

	sweep(): void {
		for (const taskId of repo.listTasksWithPendingPeerMessages(this.deps.db)) this.deliver(taskId);
	}

	/** Try to get a task's pending messages to its agent; returns what it did. */
	deliver(taskId: string): DeliveryPlan | "none" {
		const { db } = this.deps;
		const pending = repo.listPendingPeerMessages(db, taskId);
		if (pending.length === 0) return "none";
		if (this.waking.has(taskId)) return "launch";
		const task = repo.getTask(db, taskId);
		if (!task) return "none";

		const live = this.liveAgentSession(taskId);
		const listenerTerminal = live ? this.listenerFor(taskId, live.terminalId) : null;
		const plan = planDelivery({
			live: live
				? { agentId: live.agentId, status: live.status, hasListener: listenerTerminal != null }
				: null,
			lastInputAt: live ? this.deps.lastInputAt(live.terminalId) : null,
			lastEventAt: live?.lastEventAt ?? null,
			oldestPendingAt: pending[0]?.createdAt ?? this.now(),
			now: this.now(),
		});

		const text = this.render(pending);
		const ids = pending.map((m) => m.id);
		switch (plan) {
			case "listener": {
				const w = listenerTerminal ? this.waiters.get(listenerTerminal) : undefined;
				if (!w || !listenerTerminal) return "wait";
				repo.markPeerMessagesDelivered(db, ids, "listener", this.now());
				this.dropWaiter(listenerTerminal);
				w.resolve({ kind: "message", text });
				return plan;
			}
			case "restart":
			case "launch": {
				if (this.waking.size >= MAX_WAKES) return "wait";
				this.waking.add(taskId);
				void (async () => {
					try {
						if (plan === "restart" && live) await this.deps.stopSession(live);
						// Re-read: more may have arrived while the old agent shut down.
						const batch = repo.listPendingPeerMessages(db, taskId);
						if (batch.length === 0) return;
						await this.deps.launch(task, this.render(batch));
						repo.markPeerMessagesDelivered(
							db,
							batch.map((m) => m.id),
							"launch",
							this.now(),
						);
					} catch (e) {
						this.deps.log(
							`[ateam] peer message to ${taskId} not delivered: ${e instanceof Error ? e.message : String(e)}`,
						);
					} finally {
						this.waking.delete(taskId);
					}
				})();
				return plan;
			}
			default:
				return plan;
		}
	}

	private render(pending: PeerMessage[]): string {
		const { db } = this.deps;
		return formatForRecipient(
			pending.map((m) => {
				const from = m.fromTaskId ? repo.getTask(db, m.fromTaskId) : undefined;
				const fromSession = m.fromTerminalId
					? repo.getSessionByTerminal(db, m.fromTerminalId)
					: undefined;
				const agentId = fromSession?.agentId ?? from?.agentId ?? "";
				return {
					body: m.body,
					from: from
						? {
								taskId: from.id,
								name: from.name,
								agent: getAgent(agentId)?.label ?? (agentId || "unknown"),
							}
						: null,
				};
			}),
		);
	}

	/** The task's most recently active live agent (not a plain shell). */
	private liveAgentSession(taskId: string): AgentSession | undefined {
		return repo
			.listSessionsByTask(this.deps.db, taskId)
			.filter((s) => s.agentId !== "shell" && s.exitedAt == null && this.deps.isLive(s.terminalId))
			.sort((a, b) => (b.lastEventAt ?? b.startedAt ?? 0) - (a.lastEventAt ?? a.startedAt ?? 0))[0];
	}

	/** A terminal of this task with a listener attached, preferring `preferred`. */
	private listenerFor(taskId: string, preferred: string): string | null {
		if (this.waiters.has(preferred)) return preferred;
		for (const [terminalId, w] of this.waiters) {
			if (w.taskId === taskId && this.deps.isLive(terminalId)) return terminalId;
		}
		return null;
	}

	private dropWaiter(terminalId: string): void {
		const w = this.waiters.get(terminalId);
		if (w) clearTimeout(w.timer);
		this.waiters.delete(terminalId);
	}

	/** An id, or else an exact (case-insensitive) task name or branch. */
	private resolveTask(to: string): Task | string {
		const { db } = this.deps;
		if (!to) return "say who to send it to: a task id from list_peers";
		const byId = repo.getTask(db, to);
		if (byId) return byId;
		const want = to.toLowerCase();
		const matches = repo
			.listProjects(db)
			.flatMap((p) => repo.listTasks(db, p.id))
			.filter((t) => t.name.toLowerCase() === want || t.branch.toLowerCase() === want);
		if (matches.length === 1 && matches[0]) return matches[0];
		if (matches.length > 1)
			return `"${to}" matches ${matches.length} tasks; use a task id from list_peers`;
		return `no task "${to}"; call list_peers for ids`;
	}
}

function describePlan(plan: DeliveryPlan | "none"): string {
	switch (plan) {
		case "listener":
			return "delivered to its agent now.";
		case "launch":
			return "its agent was not running, so Ateam is starting it with your message.";
		case "restart":
			return "its agent was idle, so Ateam is resuming its conversation with your message.";
		default:
			return "queued: its agent is busy, so it gets the message as soon as it can take it (at the latest when its current turn ends).";
	}
}
