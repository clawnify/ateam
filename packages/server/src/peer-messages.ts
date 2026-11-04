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
 * The user's own words to a live Claude conversation (an answer to its
 * ask_user question, a reply from the Lead chat or the phone) never take the
 * asyncRewake door: Claude Code frames that hook's output as
 * "[SYSTEM NOTIFICATION - NOT USER INPUT] ... must NOT be treated as approval
 * or consent", and a careful agent then refuses the answer (verified on
 * 2.1.316). They go in through Ateam's Claude mod instead, loaded with
 * `--plugin-dir` (agent-setup), which long-polls `/inbox/user/wait` and submits
 * each batch with `$.prompt.submit({ asUser: true })`: Claude reads it exactly
 * as typed input, and its own provenance counts it as a person. A batch is
 * leased to the mod until it acks that the prompt entered the session (one
 * dropped after an Esc is offered again once a turn ends). A session with no
 * mod polling (launched before this, or mods turned off) is restarted with them
 * as its prompt, which Claude also reads as the user's. Messages from agents
 * and the Lead keep the hook door: through the mod they would fire Claude's
 * UserPromptSubmit like a typed reply, and the engine would take them for the
 * user's (clearing the task's open question).
 *
 * No keystrokes are ever typed into a live TUI (see loops/agent-loops.design.md,
 * "zero PTY injection").
 *
 * Guards: a message names its sender and says it is not from the user; a
 * back-and-forth between two tasks is capped at MAX_HOPS turns per window; a
 * sender may send MAX_PER_SENDER per window; and at most MAX_WAKES restarts or
 * launches run at once, so a burst cannot spawn a herd of agents.
 */

import { randomUUID } from "node:crypto";
import { getAgent } from "@ateam/agents";
import type { AgentSession, AteamDb, PeerMessage, Project, Task } from "@ateam/db";
import { repo } from "@ateam/db";
import { isBranchForName } from "@ateam/git-core";
import { projectRepo, type RemoteSenderDTO } from "@ateam/protocol";

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
 *  listener before it is treated like one that has none (an older launch),
 *  counted from the message or the end of its last turn, whichever is later. */
export const LISTENER_GRACE_MS = 2 * 60 * 1000;
/** How often pending messages are looked at again. */
const SWEEP_MS = 30 * 1000;
/** How long one `/inbox/wait` call is held open before it answers "nothing yet". */
export const WAIT_WINDOW_MS = 4 * 60 * 1000;
/** The same for the Claude mod's `/inbox/user/wait`: under the 30 s Claude Code
 *  gives one `$.http.fetch` call, body included. */
export const USER_WAIT_WINDOW_MS = 20 * 1000;
/** The mod polls again as soon as each call answers, so one not heard from for
 *  this long is gone (mods turned off, or its worker crashed). */
export const MOD_FRESH_MS = 60 * 1000;
/** How long after a Claude session starts, or this engine does, a mod that has
 *  not polled yet is still expected. */
export const MOD_GRACE_MS = 60 * 1000;
/** How long a batch handed to the mod waits for its ack before it is offered again. */
export const MOD_LEASE_MS = 30 * 60 * 1000;

/**
 * The sender id a message from the Lead chat carries in `fromTerminalId` (with
 * no `fromTaskId`): the Lead is not a task, it is the user's coordinator. Not a
 * UUID, so it can never collide with a real terminal's id.
 */
export const LEAD_SENDER = "ateam:lead";
/** The same for the user answering an agent's question from an Ateam client. */
export const USER_SENDER = "ateam:user";
/** The id an agent on another box carries in `fromTerminalId` (cross-box): its
 *  task's id, which stays the same while its name changes. Not a UUID, so it
 *  never collides with a real terminal's id. */
export const remoteSenderKey = (taskId: string): string => `ateam:task:${taskId}`;

/** Senders that are not a task's agent, by the id they carry in `fromTerminalId`. */
export type OutsideSender = "lead" | "user";
const OUTSIDE_IDS: Record<OutsideSender, string> = { lead: LEAD_SENDER, user: USER_SENDER };
/** Messages one outside sender may send inside SENDER_WINDOW_MS. The Lead is
 *  driven by the user, but it is still a model in a loop, so it gets a cap. */
export const MAX_FROM_LEAD = 60;

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

/** A restart would throw work away: the agent is busy, or someone typed into it. */
function holdsWork(
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

export function planDelivery(f: DeliveryFacts): DeliveryPlan {
	if (!f.live) return "launch";
	if (f.live.hasListener) return "listener";
	if (holdsWork(f.live.status, f.lastInputAt, f.lastEventAt, f.now)) return "wait";
	// A harness that listens is expected to register; give it a moment so a
	// message is not delivered by a restart instead. The moment runs from the
	// later of the message and the turn's end: Claude's listener is re-armed by
	// the very Stop that brings us here, a few ms after it, so a message that
	// waited out a long turn would otherwise find the grace already spent and
	// kill an agent that was about to take it live.
	if (
		LISTENS.has(f.live.agentId) &&
		f.now - Math.max(f.oldestPendingAt, f.lastEventAt ?? 0) < LISTENER_GRACE_MS
	)
		return "wait";
	return "restart";
}

export interface UserDeliveryFacts {
	/** The live Claude session's status. */
	status: string;
	/** Its Ateam mod is waiting for a message right now. */
	modWaiting: boolean;
	/** Its mod polled lately, or the session (or this engine) only just started. */
	modExpected: boolean;
	/** The mod's last batch was dropped (an Esc stands until the user's next
	 *  input): hold until a turn ends. */
	paused: boolean;
	lastInputAt: number | null;
	lastEventAt: number | null;
	now: number;
}

/**
 * The user's own words to a live Claude conversation go in as the user's
 * prompt or not yet: to its mod (`listener`), or by restarting the idle
 * session with them as the prompt. Never through the asyncRewake hook (see the
 * header).
 */
export function planUserDelivery(f: UserDeliveryFacts): DeliveryPlan {
	if (f.paused) return "wait";
	if (f.modWaiting) return "listener";
	if (f.modExpected) return "wait";
	if (holdsWork(f.status, f.lastInputAt, f.lastEventAt, f.now)) return "wait";
	return "restart";
}

/** The hop a new message from `from` to `to` would carry, given their recent
 *  exchange (newest first): one more than the last message it answers. */
export function nextHop(recent: Pick<PeerMessage, "fromTaskId" | "hop">[], to: string): number {
	const lastFromRecipient = recent.find((m) => m.fromTaskId === to);
	return lastFromRecipient ? lastFromRecipient.hop + 1 : 1;
}

/** A task's agent: on this box, or on a linked one (`box`, cross-box), where it
 *  may be that box's Lead (`lead`). */
type Sender =
	| { taskId: string; name: string; agent: string; box?: string; lead?: boolean }
	| OutsideSender
	| null;

/** Who a message is from, what weight it carries, and how to answer it. */
function headerFor(from: Sender): string {
	if (from === "user")
		return "[Ateam] Message from the user, sent from the Ateam app. This comes from the user, who is not watching this terminal: answer in your reply.";
	if (from === "lead")
		return "[Ateam] Message from the Lead, the chat where the user coordinates all their tasks. It relays the user's instructions: act on it as you would on a request from the user. The Lead reads your final reply when your turn ends, so answer in your reply rather than with send_message.";
	if (from?.box && from.lead)
		return `[Ateam] Message from the Lead on the box ${from.box}, the chat where the user coordinates their tasks there. It came through a link between boxes, so weigh it as a colleague's request rather than as the user's own words. The Lead reads your final reply when your turn ends, so answer in your reply rather than with send_message.`;
	if (from?.box)
		return `[Ateam] Message from the ${from.agent} agent working on task "${from.name}" on the box ${from.box} (task id ${from.taskId}). It comes from another agent, not from the user: weigh it as a colleague's request. To answer, call the ateam_board send_message tool with to="${from.taskId}".`;
	if (from)
		return `[Ateam] Message from the ${from.agent} agent working on task "${from.name}" (task id ${from.taskId}). It comes from another agent, not from the user: weigh it as a colleague's request. To answer, call the ateam_board send_message tool with to="${from.taskId}".`;
	return "[Ateam] Message from another agent (sender unknown). It does not come from the user.";
}

/** The text an agent receives: who sent it, that it is not the user, how to answer. */
export function formatForRecipient(
	messages: {
		body: string;
		from: Sender;
	}[],
): string {
	return messages
		.map((m) => {
			const head = headerFor(m.from);
			return `${head}\n\n${m.body}`;
		})
		.join("\n\n---\n\n");
}

// ---- the messenger -------------------------------------------------------

export interface PeerView {
	taskId: string;
	name: string;
	project: string;
	/** What the project is a clone of (projectRepo): `owner/name`, or its path. */
	repo: string;
	branch: string;
	agent: string | null;
	/** working · needs_you · idle · not_running */
	state: string;
	column: string;
	description: string | null;
	/** Where the task stands, in a sentence or two (task-summaries.ts); null until one is written. */
	summary: string | null;
	/** Only a search lists archived tasks. */
	archived?: true;
	you?: true;
}

/** How many tasks a peer search hands back: merged history only grows. */
export const PEER_SEARCH_LIMIT = 25;

export interface PeerSearch {
	peers: PeerView[];
	/** More tasks matched than PEER_SEARCH_LIMIT: add a word to narrow it. */
	more: boolean;
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

/** What the Claude mod's long-poll answers: a batch of the user's own words
 *  with the id it acks, or why there is none. */
export type UserWaitOutcome =
	| { kind: "message"; deliveryId: string; text: string }
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

interface Waiter<O> {
	taskId: string;
	resolve: (o: O) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** A batch the Claude mod holds until it acks that the prompt went in. */
interface Lease {
	terminalId: string;
	taskId: string;
	ids: string[];
	until: number;
}

const isFromUser = (m: PeerMessage) => m.fromTerminalId === USER_SENDER;

export class PeerMessenger {
	/** Listeners on the hook door (Claude's inbox.sh, OpenCode's plugin). */
	private waiters = new Map<string, Waiter<WaitOutcome>>();
	/** Claude mods waiting for the user's own words, by terminal. */
	private modWaiters = new Map<string, Waiter<UserWaitOutcome>>();
	/** When each terminal's mod last polled. */
	private modSeenAt = new Map<string, number>();
	private leases = new Map<string, Lease>();
	/** Terminals whose mod had a batch dropped, with their task: held until a
	 *  turn ends there (kick). */
	private paused = new Map<string, string>();
	private waking = new Set<string>();
	private sweepTimer: ReturnType<typeof setInterval> | null = null;
	private readonly now: () => number;
	private readonly startedAt: number;

	constructor(private deps: PeerMessengerDeps) {
		this.now = deps.now ?? Date.now;
		this.startedAt = this.now();
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
		// Not "gone": a mod polls only from its session's start, so one told to
		// stop would be dead for the next engine. inbox.sh is re-armed at a Stop.
		for (const [id, w] of this.modWaiters) {
			clearTimeout(w.timer);
			w.resolve({ kind: "timeout" });
			this.modWaiters.delete(id);
		}
	}

	/** Every task outside `merged`, as a sender would choose among them. */
	listPeers(callerTerminalId: string | undefined): PeerView[] {
		const { db } = this.deps;
		const callerTaskId = this.callerTaskId(callerTerminalId);
		const peers: PeerView[] = [];
		for (const project of repo.listProjects(db)) {
			for (const task of repo.listTasks(db, project.id)) {
				if (task.column === "merged") continue;
				peers.push(this.peerView(task, project, callerTaskId));
			}
		}
		return peers;
	}

	/**
	 * The newest tasks whose name, branch or description holds every word of
	 * `search`, merged and archived ones too. send() reaches those, but
	 * listPeers leaves them out, so without this an agent told to hand work back
	 * to the task that built something had no way to find it and went reading
	 * the sqlite file instead.
	 */
	searchPeers(callerTerminalId: string | undefined, search: string): PeerSearch {
		const { db } = this.deps;
		const callerTaskId = this.callerTaskId(callerTerminalId);
		const projects = new Map(repo.listProjects(db).map((p) => [p.id, p]));
		const terms = search.split(/\s+/).filter(Boolean);
		const rows = repo.searchTasks(db, terms, PEER_SEARCH_LIMIT + 1);
		const peers: PeerView[] = [];
		for (const task of rows.slice(0, PEER_SEARCH_LIMIT)) {
			const project = projects.get(task.projectId);
			if (project) peers.push(this.peerView(task, project, callerTaskId));
		}
		return { peers, more: rows.length > PEER_SEARCH_LIMIT };
	}

	private callerTaskId(callerTerminalId: string | undefined): string | undefined {
		return callerTerminalId
			? repo.getSessionByTerminal(this.deps.db, callerTerminalId)?.taskId
			: undefined;
	}

	private peerView(task: Task, project: Project, callerTaskId: string | undefined): PeerView {
		const live = this.liveAgentSession(task.id);
		return {
			taskId: task.id,
			name: task.name,
			project: project.name,
			repo: projectRepo(project),
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
			summary: task.summary ?? null,
			...(task.archivedAt != null ? { archived: true as const } : {}),
			...(task.id === callerTaskId ? { you: true as const } : {}),
		};
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
		const plan = this.deliverParts(target.id).rest;
		return { ok: true, reason: `sent to "${target.name}" (${target.id}): ${describePlan(plan)}` };
	}

	/** Whether `to` names no task on this box at all, so a linked box may have it
	 *  (cross-box). A name that matches several tasks here is still this box's. */
	missing(to: string): boolean {
		const want = to.trim();
		return this.resolveTask(want) === notFound(want);
	}

	/** The checks before an agent here messages the task `to` (an id) on a linked
	 *  box, and what that box needs: who sent it, and the hop, worked out from the
	 *  messages that task sent this one (they are kept here, the receiving end). */
	outgoing(req: {
		fromTerminalId: string;
		to: string;
		body: string;
	}):
		| { ok: false; reason: string }
		| { ok: true; body: string; hop: number; from: Omit<RemoteSenderDTO, "box"> } {
		const { db } = this.deps;
		const session = repo.getSessionByTerminal(db, req.fromTerminalId);
		const task = session ? repo.getTask(db, session.taskId) : undefined;
		if (!session || !task)
			return { ok: false, reason: "only an agent working in a task can send messages" };
		const body = req.body.trim();
		if (!body) return { ok: false, reason: "the message is empty" };
		if (body.length > MAX_BODY) {
			return {
				ok: false,
				reason: `the message is ${body.length} characters; the limit is ${MAX_BODY}. Put the detail in a file in your worktree and send its path.`,
			};
		}
		const since = this.now() - HOP_WINDOW_MS;
		const last = repo.listPeerMessagesFromTerminalTo(
			db,
			remoteSenderKey(req.to),
			task.id,
			since,
		)[0];
		const hop = last ? last.hop + 1 : 1;
		if (hop > MAX_HOPS) {
			return {
				ok: false,
				reason: `you and that task have traded ${MAX_HOPS} messages in the last ${HOP_WINDOW_MS / 60000} minutes. Stop and tell the user what is unresolved instead of sending more.`,
			};
		}
		const agentId = session.agentId || task.agentId || "";
		return {
			ok: true,
			body,
			hop,
			from: {
				taskId: task.id,
				name: task.name,
				agent: getAgent(agentId)?.label ?? (agentId || "unknown"),
			},
		};
	}

	/** Queue a message from an agent on a linked box (peers:sendFromBox) to the
	 *  task `to` here, then try to deliver it. Its box worked out the hop; the cap
	 *  on how much one sender sends is kept here, where its messages land. */
	receive(
		req: { to: unknown; body: unknown; hop?: unknown; from: unknown },
		viaBox?: string,
	): SendResult {
		const { db } = this.deps;
		const now = this.now();
		const from = remoteSender(req.from);
		if (!from) return { ok: false, reason: "the message doesn't say which agent sent it" };
		// A link that is paired here is named by its pairing, not by what it says.
		if (viaBox?.trim()) from.box = viaBox.trim().slice(0, 100);
		const body = typeof req.body === "string" ? req.body.trim() : "";
		if (!body) return { ok: false, reason: "the message is empty" };
		if (body.length > MAX_BODY) {
			return {
				ok: false,
				reason: `the message is ${body.length} characters; the limit is ${MAX_BODY}.`,
			};
		}
		const target = this.resolveTask(typeof req.to === "string" ? req.to.trim() : "");
		if (typeof target === "string") return { ok: false, reason: target };
		// A Lead's messages count against that box's Lead, like the Lead here, and
		// no back-and-forth cap: it is the user's coordinator, not a peer.
		const key = from.lead ? `ateam:lead:${from.box}` : remoteSenderKey(from.taskId);
		const cap = from.lead ? MAX_FROM_LEAD : MAX_PER_SENDER;
		if (repo.countPeerMessagesFromTerminal(db, key, now - SENDER_WINDOW_MS) >= cap) {
			return {
				ok: false,
				reason: `rate limit: at most ${cap} messages per ${SENDER_WINDOW_MS / 60000} minutes`,
			};
		}
		const hop =
			!from.lead && typeof req.hop === "number" && Number.isInteger(req.hop) && req.hop >= 1
				? req.hop
				: 1;
		if (hop > MAX_HOPS) {
			return {
				ok: false,
				reason: `you and "${target.name}" have traded ${MAX_HOPS} messages in the last ${HOP_WINDOW_MS / 60000} minutes. Stop and tell the user what is unresolved instead of sending more.`,
			};
		}
		repo.insertPeerMessage(db, {
			fromTaskId: null,
			fromTerminalId: key,
			fromRemote: JSON.stringify(from),
			toTaskId: target.id,
			body,
			hop,
			createdAt: now,
		});
		const plan = this.deliverParts(target.id).rest;
		return { ok: true, reason: `sent to "${target.name}" (${target.id}): ${describePlan(plan)}` };
	}

	/** Queue a message from a sender that is not a task (the Lead chat, or the
	 *  user answering a question) to the task `to` (an id, or a task's exact name
	 *  or branch), then try to deliver it. The hop cap between two tasks does not
	 *  apply; a rate cap per sender does. */
	sendFrom(sender: OutsideSender, req: { to: string; body: string }): SendResult {
		const senderId = OUTSIDE_IDS[sender];
		const { db } = this.deps;
		const now = this.now();
		const body = req.body.trim();
		if (!body) return { ok: false, reason: "the message is empty" };
		if (body.length > MAX_BODY) {
			return {
				ok: false,
				reason: `the message is ${body.length} characters; the limit is ${MAX_BODY}.`,
			};
		}
		const target = this.resolveTask(req.to.trim());
		if (typeof target === "string") return { ok: false, reason: target };
		if (repo.countPeerMessagesFromTerminal(db, senderId, now - SENDER_WINDOW_MS) >= MAX_FROM_LEAD) {
			return {
				ok: false,
				reason: `rate limit: at most ${MAX_FROM_LEAD} messages per ${SENDER_WINDOW_MS / 60000} minutes`,
			};
		}
		repo.insertPeerMessage(db, {
			fromTaskId: null,
			fromTerminalId: senderId,
			toTaskId: target.id,
			body,
			hop: 1,
			createdAt: now,
		});
		// The door this message took: the user's own words may go apart from the rest.
		const parts = this.deliverParts(target.id);
		const plan = sender === "user" && parts.user !== "none" ? parts.user : parts.rest;
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

	/**
	 * The Claude mod asking for this terminal's messages from the user. Like
	 * `wait`, on its own slot so it never displaces the hook listener, and with
	 * a window that fits a mod's fetch. A batch it gets is leased, not
	 * delivered, until `ackUser`.
	 */
	waitUser(terminalId: string): { result: Promise<UserWaitOutcome>; cancel: () => void } {
		const { db } = this.deps;
		const session = repo.getSessionByTerminal(db, terminalId);
		if (!session || !this.deps.isLive(terminalId)) {
			return { result: Promise.resolve({ kind: "gone" }), cancel: () => {} };
		}
		this.modSeenAt.set(terminalId, this.now());
		this.modWaiters.get(terminalId)?.resolve({ kind: "superseded" });
		this.dropModWaiter(terminalId);
		let cancel = () => {};
		const result = new Promise<UserWaitOutcome>((resolve) => {
			const timer = setTimeout(() => {
				this.dropModWaiter(terminalId);
				resolve({ kind: "timeout" });
			}, USER_WAIT_WINDOW_MS);
			this.modWaiters.set(terminalId, { taskId: session.taskId, resolve, timer });
			cancel = () => {
				if (this.modWaiters.get(terminalId)?.resolve === resolve) this.dropModWaiter(terminalId);
			};
		});
		this.deliver(session.taskId);
		return { result, cancel };
	}

	/**
	 * The mod says what became of a batch: `entered`, the prompt is in the
	 * session (delivered); otherwise Claude dropped it (an Esc stands until the
	 * user's next input), so it is offered again once a turn ends there. False
	 * for a lease this terminal does not hold.
	 */
	ackUser(terminalId: string, deliveryId: string, entered: boolean): boolean {
		const lease = this.leases.get(deliveryId);
		if (!lease || lease.terminalId !== terminalId) return false;
		this.leases.delete(deliveryId);
		if (entered) {
			repo.markPeerMessagesDelivered(this.deps.db, lease.ids, "mod", this.now());
		} else {
			this.paused.set(terminalId, lease.taskId);
		}
		return true;
	}

	/** Look at a task again (its agent's turn ended, it exited, ...). */
	kick(taskId: string): void {
		// A turn ended: whatever the user's Esc held back can go in now.
		for (const [terminalId, t] of this.paused) if (t === taskId) this.paused.delete(terminalId);
		if (repo.listPendingPeerMessages(this.deps.db, taskId).length > 0) this.deliver(taskId);
	}

	/** Every task with something pending, leases past their time included. */
	sweep(): void {
		for (const taskId of repo.listTasksWithPendingPeerMessages(this.deps.db)) this.deliver(taskId);
	}

	/** Try to get a task's pending messages to its agent; returns what it did. */
	deliver(taskId: string): DeliveryPlan | "none" {
		const { user, rest } = this.deliverParts(taskId);
		return rest !== "none" ? rest : user;
	}

	/**
	 * `deliver`, saying what happened to the user's own words (`user`, set only
	 * for a live Claude conversation) and to everything else (`rest`).
	 */
	private deliverParts(taskId: string): {
		user: DeliveryPlan | "none";
		rest: DeliveryPlan | "none";
	} {
		const none = { user: "none", rest: "none" } as const;
		const { db } = this.deps;
		const pending = this.pendingFor(taskId);
		if (pending.length === 0) return none;
		if (this.waking.has(taskId)) return { user: "launch", rest: "launch" };
		const task = repo.getTask(db, taskId);
		if (!task) return none;

		const live = this.liveAgentSession(taskId);
		// A conversation Ateam launched by id. Agent mode has none: a board, not a
		// conversation, keeps the hook door for everything.
		const conversation = live?.agentId === "claude" && live.agentSessionId != null;
		const mine = conversation ? pending.filter(isFromUser) : [];
		const rest = mine.length > 0 ? pending.filter((m) => !isFromUser(m)) : pending;
		return {
			user: live && mine.length > 0 ? this.deliverUser(task, live, mine) : "none",
			rest: rest.length > 0 ? this.deliverRest(task, live, rest) : "none",
		};
	}

	/** The user's own words to a live Claude conversation (planUserDelivery). */
	private deliverUser(task: Task, live: AgentSession, batch: PeerMessage[]): DeliveryPlan {
		const now = this.now();
		const { terminalId } = live;
		const waiter = this.modWaiters.get(terminalId);
		const seen = this.modSeenAt.get(terminalId);
		const plan = planUserDelivery({
			status: live.status,
			modWaiting: waiter != null,
			modExpected:
				(seen != null && now - seen < MOD_FRESH_MS) ||
				now - Math.max(live.startedAt ?? 0, this.startedAt) < MOD_GRACE_MS,
			paused: this.paused.has(terminalId),
			lastInputAt: this.deps.lastInputAt(terminalId),
			lastEventAt: live.lastEventAt ?? null,
			now,
		});
		if (plan === "listener" && waiter) {
			const deliveryId = randomUUID();
			this.leases.set(deliveryId, {
				terminalId,
				taskId: task.id,
				ids: batch.map((m) => m.id),
				until: now + MOD_LEASE_MS,
			});
			this.dropModWaiter(terminalId);
			waiter.resolve({ kind: "message", deliveryId, text: this.render(batch) });
			return plan;
		}
		if (plan === "restart") return this.wake(task, live, plan);
		return plan;
	}

	/** Everything else, through the hook door, a restart or a launch. */
	private deliverRest(
		task: Task,
		live: AgentSession | undefined,
		batch: PeerMessage[],
	): DeliveryPlan {
		const listenerTerminal = live ? this.listenerFor(task.id, live.terminalId) : null;
		const plan = planDelivery({
			live: live
				? { agentId: live.agentId, status: live.status, hasListener: listenerTerminal != null }
				: null,
			lastInputAt: live ? this.deps.lastInputAt(live.terminalId) : null,
			lastEventAt: live?.lastEventAt ?? null,
			oldestPendingAt: batch[0]?.createdAt ?? this.now(),
			now: this.now(),
		});
		switch (plan) {
			case "listener": {
				const w = listenerTerminal ? this.waiters.get(listenerTerminal) : undefined;
				if (!w || !listenerTerminal) return "wait";
				repo.markPeerMessagesDelivered(
					this.deps.db,
					batch.map((m) => m.id),
					"listener",
					this.now(),
				);
				this.dropWaiter(listenerTerminal);
				w.resolve({ kind: "message", text: this.render(batch) });
				return plan;
			}
			case "restart":
			case "launch":
				return this.wake(task, live, plan);
			default:
				return plan;
		}
	}

	/**
	 * Restart the live agent (or start one) with everything pending as its
	 * prompt, the user's words and anything else alike: a launch prompt is the
	 * user's own turn to every harness.
	 */
	private wake(task: Task, live: AgentSession | undefined, plan: DeliveryPlan): DeliveryPlan {
		if (this.waking.has(task.id)) return "launch";
		if (this.waking.size >= MAX_WAKES) return "wait";
		this.waking.add(task.id);
		void (async () => {
			try {
				if (plan === "restart" && live) await this.deps.stopSession(live);
				// Re-read: more may have arrived while the old agent shut down, and a
				// batch its mod held went with it.
				const batch = this.pendingFor(task.id);
				if (batch.length === 0) return;
				await this.deps.launch(task, this.render(batch));
				repo.markPeerMessagesDelivered(
					this.deps.db,
					batch.map((m) => m.id),
					"launch",
					this.now(),
				);
			} catch (e) {
				this.deps.log(
					`[ateam] peer message to ${task.id} not delivered: ${e instanceof Error ? e.message : String(e)}`,
				);
			} finally {
				this.waking.delete(task.id);
			}
		})();
		return plan;
	}

	/**
	 * A task's undelivered messages, less those a live mod holds. A lease past
	 * its time, or on a terminal that is gone, is given up here, so its batch
	 * is offered again.
	 */
	private pendingFor(taskId: string): PeerMessage[] {
		const now = this.now();
		const held = new Set<string>();
		for (const [id, lease] of this.leases) {
			if (lease.taskId !== taskId) continue;
			if (lease.until <= now || !this.deps.isLive(lease.terminalId)) this.leases.delete(id);
			else for (const m of lease.ids) held.add(m);
		}
		return repo.listPendingPeerMessages(this.deps.db, taskId).filter((m) => !held.has(m.id));
	}

	private render(pending: PeerMessage[]): string {
		const { db } = this.deps;
		return formatForRecipient(
			pending.map((m) => {
				const remote = m.fromRemote ? remoteSender(safeJson(m.fromRemote)) : null;
				const from = m.fromTaskId ? repo.getTask(db, m.fromTaskId) : undefined;
				const fromSession = m.fromTerminalId
					? repo.getSessionByTerminal(db, m.fromTerminalId)
					: undefined;
				const agentId = fromSession?.agentId ?? from?.agentId ?? "";
				return {
					body: m.body,
					from:
						m.fromTerminalId === LEAD_SENDER
							? ("lead" as const)
							: m.fromTerminalId === USER_SENDER
								? ("user" as const)
								: remote
									? remote
									: from
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

	private dropModWaiter(terminalId: string): void {
		const w = this.modWaiters.get(terminalId);
		if (w) clearTimeout(w.timer);
		this.modWaiters.delete(terminalId);
	}

	/**
	 * An id, or else an exact (case-insensitive) task name or branch, or else a
	 * name the task's branch was made from: a task named from its prompt's first
	 * words is renamed once by the model (task-labels.ts), and a peer that learned
	 * the first name still reaches it, since the branch keeps those words.
	 */
	private resolveTask(to: string): Task | string {
		const { db } = this.deps;
		if (!to) return "say who to send it to: a task id from list_peers";
		const byId = repo.getTask(db, to);
		if (byId) return byId;
		const want = to.toLowerCase();
		const all = repo
			.listProjects(db)
			// Archived too: a task named outright is still reachable, and the
			// delivery's activity brings it back.
			.flatMap((p) => repo.listTasks(db, p.id, { includeArchived: true }));
		const exact = all.filter(
			(t) => t.name.toLowerCase() === want || t.branch.toLowerCase() === want,
		);
		// A name a task no longer carries only counts when no task carries it now.
		const matches = exact.length > 0 ? exact : all.filter((t) => isBranchForName(t.branch, to));
		if (matches.length === 1 && matches[0]) return matches[0];
		if (matches.length > 1)
			return `"${to}" matches ${matches.length} tasks; use a task id from list_peers`;
		return notFound(to);
	}
}

const notFound = (to: string): string => `no task "${to}"; call list_peers for ids`;

/** Text no longer than `max`, or null: what another box says about its agent. */
const shortText = (v: unknown, max = 200): string | null =>
	typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

/** The sender another box named, checked: every field present and short. */
function remoteSender(v: unknown): RemoteSenderDTO | null {
	if (!v || typeof v !== "object") return null;
	const o = v as Record<string, unknown>;
	const box = shortText(o.box, 100);
	if (box && o.lead === true)
		return { box, taskId: "lead", name: "Lead", agent: "Lead", lead: true };
	const taskId = shortText(o.taskId, 100);
	const name = shortText(o.name);
	const agent = shortText(o.agent, 100);
	return box && taskId && name && agent ? { box, taskId, name, agent } : null;
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
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
