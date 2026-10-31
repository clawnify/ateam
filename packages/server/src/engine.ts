// The Ateam engine: constructs the whole local subsystem (SQLite, PTY daemon
// client, hook server, merge queue, loops) and owns the agent → board state
// machine. It is transport-agnostic — instead of pushing to an Electron
// renderer it EMITS abstract events, so the desktop shell (which forwards them
// to webContents) and the SSH server (which frames them as JSON-RPC
// notifications) drive the exact same engine.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, repo, type SessionExitReason } from "@ateam/db";
import type {
	AgentStatus,
	KanbanColumn,
	LoopDTO,
	MergeStrategy,
	PtyDataEvent,
	PtyExitEvent,
	TaskDTO,
} from "@ateam/protocol";
import { ensureGhShim, ensureNotifyScript, ensurePeerSecret, verifyPeerToken } from "./agent-setup";
import { ARCHIVE_SWEEP_MS, archiveIdleTasks } from "./archive";
import { stampBrowserUse } from "./browser";
import { FollowUps } from "./follow-ups";
import { type HookEvent, HookServer, type MergeRequestEvent } from "./hooks/hook-server";
import { ensureLoginEnv } from "./login-env";
import { applySetStatus, buildBoardView } from "./loops/board-signals";
import { LoopRunner } from "./loops/runner";
import { MergeQueue } from "./merge-queue";
import { PeerMessenger } from "./peer-messages";
import { applyAgentQuit, columnAfterExit } from "./pty/agent-quit";
import { PtyClient } from "./pty/pty-client";
import { reapableSessions } from "./pty/reap";
import { makeStrandReconciler } from "./pty/reconcile";
import { liveAgentIds, type Services, toTaskDTO } from "./services";
import { createTaskInProject, spawnAgentInTask } from "./sessions";
import { PermissionBridge } from "./permissions";
import { applyShowPage } from "./pages";
import { answerQuestion, applyAskUser, CLEAR_QUESTION } from "./questions";
import { readSettings } from "./settings-file";
import { createTurnClassifier } from "./turn-classifier";
import { applySetWaiting, CLEAR_WAIT, isFiredWait, WaitTimers } from "./waits";
import { WorktreeGuard } from "./worktree-guard";
import { createWorktreeSweep, type WorktreeSweep } from "./worktree-sweep";

export interface EngineOptions {
	/** Where the SQLite db, hooks, and notify script live (app userData or ~/.ateam). */
	dataDir: string;
	/** Path to the built PTY daemon entry (out/main/daemon.js). */
	daemonPath: string;
	/** Binary that runs the detached daemon: the Electron binary as node on the
	 *  desktop, or bun/node on a server. */
	execPath: string;
	/** Unix socket for the PTY daemon (defaults to ~/.ateam/pty-daemon.sock). */
	sockPath?: string;
	log?: (line: string) => void;
}

/** Abstract engine events — the transport-neutral superset of what used to be
 *  `win.webContents.send(...)` calls. */
interface EngineEventMap {
	taskUpdated: [TaskDTO];
	taskRemoved: [string];
	loopsUpdated: [LoopDTO[]];
	ptyData: [PtyDataEvent];
	ptyExit: [PtyExitEvent];
}

export interface Engine {
	readonly services: Services;
	on<K extends keyof EngineEventMap>(
		event: K,
		listener: (...args: EngineEventMap[K]) => void,
	): () => void;
	/** Re-read a task and emit taskUpdated (used across handlers + loops). */
	sendTaskUpdated(taskId: string): void;
	/** Emit taskRemoved so every client drops the deleted task's card. */
	sendTaskRemoved(taskId: string): void;
	/** Emit the current loop list. */
	sendLoopsUpdated(): void;
	/** Queue a message to a task's agent from the Lead chat or from the user
	 *  typing in an Ateam client (peer-messages.ts). */
	messageFrom(
		sender: "lead" | "user",
		req: { to: string; body: string },
	): { ok: boolean; reason: string };
	/** Answer (or with null dismiss) the question a task's agent asked (questions.ts). */
	answerQuestion(req: {
		taskId: string;
		questionId: string;
		answer: string | string[] | null;
		via?: "lead";
	}): void;
	/** Keeps every task's git + PR facts fresh, not just the open one. The
	 *  `CH.gitStatus` handler shares its throttle (see worktree-sweep.ts). */
	readonly worktreeSweep: WorktreeSweep;
	/** Connect to (or launch) the detached PTY daemon and learn live sessions. */
	connectPty(): Promise<void>;
	/** Settles once connectPty() has finished, attached or not. The dispatcher waits
	 *  on it, so no call reads the empty live set from before the daemon's hello. */
	ptyReady(): Promise<void>;
	/** Start the user's scheduled loops (rebuilt from their persisted rows). */
	startLoops(): void;
	/**
	 * Is an agent doing work right now: a live agent session mid-turn, a task
	 * still being prepared, or a merge in flight. A session waiting on the user
	 * or finished with its turn is not work. What keeps a box awake.
	 */
	isWorking(): boolean;
	/** Detach the client and stop hooks/loops — never kills PTY sessions. */
	stop(): void;
	/** Stop just the hook server (used by the headless smoke check). */
	stopHooks(): void;
}

/** How long an agent sits finished before the app reclaims its process. */
const REAP_IDLE_MS = 2 * 60 * 60 * 1000;
/** How often to look for reapable sessions. One indexed read over open rows. */
const REAP_SWEEP_MS = 5 * 60 * 1000;

function mapEventToStatus(eventType: string): AgentStatus {
	if (eventType === "PermissionRequest") return "awaiting_input";
	if (eventType === "Stop") return "idle";
	return "running";
}

/**
 * A session's status after `eventType`. A Start is the process coming up (a
 * `--resume`, or compaction mid-turn), not work, so the session keeps what it
 * was. isWorking() reads this: a resume written as "running" held its box awake
 * for as long as the idle pane lived, because only a Stop clears it.
 */
export function sessionStatusAfter(eventType: string, current: AgentStatus): AgentStatus {
	return eventType === "Start" ? current : mapEventToStatus(eventType);
}

function mapEventToColumn(eventType: string): KanbanColumn {
	if (eventType === "PermissionRequest") return "needs_attention";
	if (eventType === "Stop") return "review";
	return "running";
}

/**
 * Does this event count as news for the user? `isUnread` is a claim about
 * novelty, and the renderer's triage order ranks ANY unread task above every
 * triage bucket, so a card that re-arms the flag on a schedule permanently
 * outranks real work.
 *
 * A loop's tick ends with a Stop on every run (hourly by default), and a
 * scheduled job finishing on schedule is not news — that is the cron contract
 * loops already declare: silent on success, loud on exception. So a loop's own
 * card skips the Stop-driven flag and keeps the PermissionRequest one, which
 * means the agent is blocked on the user and genuinely needs them.
 */
export function mapEventToUnread(eventType: string, ownedByLoop: boolean): boolean {
	if (eventType === "PermissionRequest") return true;
	return eventType === "Stop" && !ownedByLoop;
}

export async function createEngine(opts: EngineOptions): Promise<Engine> {
	const { dataDir, daemonPath, execPath } = opts;
	const emitter = new EventEmitter();
	// Captured before any session of this run can exist, so the reconcile below
	// can tell "stranded by a previous run" from "spawning right now".
	const engineStartedAt = Date.now();

	// Ensure the data dir exists. Electron's userData always does; a fresh
	// server's ~/.ateam may not, and better-sqlite3 won't create parent dirs.
	if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

	// One-time migration from the pre-rename database filename.
	const dbPath = join(dataDir, "ateam.sqlite");
	if (!existsSync(dbPath) && existsSync(join(dataDir, "grove.sqlite"))) {
		for (const suffix of ["", "-wal", "-shm"]) {
			const old = join(dataDir, `grove.sqlite${suffix}`);
			if (existsSync(old)) renameSync(old, `${dbPath}${suffix}`);
		}
	}
	const db = createDb(dbPath);
	// An agent marked at a prompt holds its card in Needs You (repo.updateTask),
	// so a mark left behind by an agent that is long gone must not.
	repo.clearStrandedPrompts(db);

	// Before anything is spawned: a GUI launch inherits launchd's PATH, so the
	// agent CLIs, `gh` and every headless turn would look uninstalled. Awaited
	// because agent detection runs seconds from here.
	await ensureLoginEnv({ db, log: opts.log ?? ((line) => console.log(line)) });

	// Prune stale image attachments (written by util:writeImageBytes to the OS temp dir
	// when a client attaches an image) older than a week, so temp files never accumulate
	// unboundedly. A path handed to an agent is read within the session it's given.
	const attachmentsDir = join(tmpdir(), "ateam-attachments");
	if (existsSync(attachmentsDir)) {
		const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
		for (const name of readdirSync(attachmentsDir)) {
			const f = join(attachmentsDir, name);
			try {
				if (statSync(f).mtimeMs < cutoff) rmSync(f);
			} catch {
				/* raced/removed — ignore */
			}
		}
	}

	// Declared here rather than inline in `services` below because the broadcast
	// closure needs it: a card's "preparing" state is exactly "is there a seed in
	// flight for this task", and that answer must ride along on every update.
	const pendingSeeds = new Map<string, Promise<void>>();

	const sendTaskUpdated = (taskId: string): void => {
		const task = repo.getTask(db, taskId);
		// An archived task is off every board. Clients add a task they have not
		// seen on an update, so a background write to one (a git-status refresh)
		// would put the card back; a removal keeps it off, old clients included.
		if (task?.archivedAt != null) {
			emitter.emit("taskRemoved", taskId);
			return;
		}
		if (task) {
			emitter.emit(
				"taskUpdated",
				toTaskDTO(task, pendingSeeds.has(taskId), liveAgentIds(db, pty, taskId)),
			);
		}
	};

	// The detached PTY daemon survives restarts; daemonPath is run via execPath as
	// node (ELECTRON_RUN_AS_NODE on the desktop) so node-pty's ABI matches.
	const pty = new PtyClient(
		daemonPath,
		opts.sockPath ?? join(homedir(), ".ateam", "pty-daemon.sock"),
		execPath,
	);
	let markPtyReady!: () => void;
	const ptyReady = new Promise<void>((r) => {
		markPtyReady = r;
	});
	const hooks = new HookServer();
	const hookPort = await hooks.start(repo.getSettings(db).hookPort ?? undefined);
	const notifyScriptPath = await ensureNotifyScript(dataDir);
	await ensureGhShim(dataDir);
	const peerSecret = await ensurePeerSecret(dataDir);
	const hooksDir = join(dataDir, "hooks");
	repo.updateSettings(db, { hookPort });

	const mergeQueue = new MergeQueue({ db, onTaskUpdated: sendTaskUpdated });
	const followUps = new FollowUps();
	// Tasks parked on an outside party resurface on their date — see waits.ts.
	const waits = new WaitTimers({ db, onExpired: sendTaskUpdated });
	// Loops are user-created only; nothing is registered here. A loop tick
	// starts an agent session through the same task-create + spawn path the
	// composer uses. (`services` is declared just below and also holds this
	// runner; loops only fire long after createEngine returns.)
	const loopRunner = new LoopRunner({
		db,
		log: opts.log ?? ((line) => console.log(line)),
		// A scheduled tick has no RPC call to answer, so it pushes its own update
		// — otherwise the UI keeps the pre-tick DTOs (no taskId, stale telemetry)
		// until some unrelated event happens to re-list.
		onChanged: () => emitter.emit("loopsUpdated", loopRunner.describe()),
		paused: () => readSettings().settings.engine.loopsPaused,
		sessions: {
			createTask: async (input) => {
				const task = await createTaskInProject(services, sendTaskUpdated, input);
				return { taskId: task.id };
			},
			spawnAgent: (input) => spawnAgentInTask(services, sendTaskUpdated, input),
			stopTaskSessions: (taskId) => {
				for (const s of repo.listSessionsByTask(db, taskId)) pty.kill(s.terminalId);
			},
			// Daemon ground truth — the persisted agentStatus can strand at
			// "running" when an exit happened while the app was closed.
			isTaskAgentLive: (taskId) =>
				repo.listSessionsByTask(db, taskId).some((s) => pty.has(s.terminalId)),
		},
	});

	// Board Organizer tools: the organizer loop's headless `claude -p` turn reads
	// the board and proposes moves through these, guarded by validateSetStatus.
	hooks.setBoardHandlers({
		get: () => buildBoardView(db),
		setStatus: async (req) => applySetStatus(db, req, sendTaskUpdated),
		setWaiting: async (req) => applySetWaiting(db, req, waits, sendTaskUpdated),
		listPeers: async (callerTerminalId) => peers.listPeers(callerTerminalId),
		sendMessage: async (req) => peers.send(req),
		askUser: async (req) => {
			const session = repo.getSessionByTerminal(db, req.callerTerminalId);
			if (!session)
				return { ok: false, reason: "only an agent working in a task can ask the user" };
			return applyAskUser(db, { taskId: session.taskId, ...req }, sendTaskUpdated);
		},
		showPage: async (req) => {
			const session = repo.getSessionByTerminal(db, req.callerTerminalId);
			if (!session) return { ok: false, reason: "only an agent working in a task can show a page" };
			return applyShowPage(db, { taskId: session.taskId, ...req }, sendTaskUpdated);
		},
	});

	// A finished turn with a follow-up armed continues instead of stopping. The
	// lookup consumes, so it can only ever fire once per launch.
	hooks.setFollowUpResolver((terminalId, eventType) => followUps.take(terminalId, eventType));

	const services: Services = {
		db,
		pty,
		hooks,
		userDataDir: dataDir,
		hooksDir,
		notifyScriptPath,
		hookPort,
		mergeQueue,
		loopRunner,
		followUps,
		pendingSeeds,
		worktreeGuard: new WorktreeGuard(),
		waits,
		peerSecret,
	};

	// Agent-to-agent messages (peer-messages.ts). Its two engine-side moves are
	// the reaper's kill and the restore path's resume, with the message as the
	// prompt; everything about WHEN lives in the messenger.
	const waitForExit = (terminalId: string, ms: number): Promise<void> =>
		new Promise((resolve) => {
			const onExit = (e: { terminalId: string }) => {
				if (e.terminalId === terminalId) done();
			};
			const timer = setTimeout(() => done(), ms);
			function done() {
				clearTimeout(timer);
				pty.off("exit", onExit);
				resolve();
			}
			pty.on("exit", onExit);
		});
	// Claude's permission prompts, answerable from any client (permissions.ts).
	const permissions = new PermissionBridge({ db, notify: (id) => sendTaskUpdated(id) });
	hooks.setPermissionHandler((req) => permissions.ask(req));

	const peers = new PeerMessenger({
		db,
		isLive: (terminalId) => pty.has(terminalId),
		lastInputAt: (terminalId) => pty.lastInputAt(terminalId),
		stopSession: async (session) => {
			// Exactly a reap (see reapIdleSessions): stamped first, so the exit
			// handler files it as reclaimed rather than as news.
			repo.demoteReapedSessions(db, session.taskId);
			repo.updateSession(db, session.id, { exitReason: "reaped" });
			const exited = waitForExit(session.terminalId, 10_000);
			pty.kill(session.terminalId);
			await exited;
		},
		launch: async (task, prompt) => {
			// The conversation the task last had, resumed by id when known; a task
			// that never had an agent gets a fresh one on the default.
			const last = repo.listSessionsByTask(db, task.id).find((s) => s.agentId !== "shell");
			const agentId =
				last?.agentId ?? task.agentId ?? readSettings().settings.engine.defaultAgentId;
			await spawnAgentInTask(services, sendTaskUpdated, {
				taskId: task.id,
				agentId,
				prompt,
				...(last
					? last.agentSessionId
						? { resumeSessionId: last.agentSessionId }
						: { resume: true }
					: {}),
			});
		},
		log: opts.log ?? ((line) => console.log(line)),
	});
	hooks.setPeerInbox({
		verify: (terminalId, token) => verifyPeerToken(peerSecret, terminalId, token),
		wait: (terminalId) => peers.wait(terminalId),
	});

	// Record an agent's exit: close the session and file its card. Shared by the
	// live exit event and the reconcile below so an exit we watched and an exit
	// we slept through land the card in the same place.
	//
	// `markUnread` is the one thing they must NOT share. A live exit is real news
	// ("your agent just finished"). The reconcile is a BACKFILL of bookkeeping we
	// missed, possibly weeks ago — flagging all of it unread would drown the
	// genuine news on a board that has hundreds of stranded cards, and claim the
	// user hasn't seen work they have. Correcting the column is the value there.
	const applyAgentExit = (
		sessionId: string,
		taskId: string,
		exitedAt: number,
		markUnread: boolean,
		exitReason: SessionExitReason,
	): void => {
		repo.updateSession(db, sessionId, { status: "stopped", exitedAt, exitReason });
		const task = repo.getTask(db, taskId);
		if (!task) return;
		if (task.column === "running") {
			repo.updateTask(db, task.id, {
				agentStatus: "stopped",
				column: columnAfterExit(task),
				...(markUnread ? { isUnread: true } : {}),
			});
		} else if (
			task.agentStatus === "awaiting_input" &&
			!repo
				.listSessionsByTask(db, task.id)
				.some((s) => s.status === "awaiting_input" && pty.has(s.terminalId))
		) {
			// No agent of the task is at a prompt now. Left as it was, the mark
			// would hold the card in Needs You (repo.updateTask) after its agent
			// is gone.
			repo.updateTask(db, task.id, { agentStatus: "stopped" });
		}
		// Announced whether or not the column moved: a session ending changes
		// what the task is running (TaskDTO.agentIds), and a shell closing on a
		// reviewed task would otherwise keep its glyph on the card for good.
		sendTaskUpdated(task.id);
	};

	// PTY output/exit → emitted for the transport to forward.
	pty.on("data", (e) => emitter.emit("ptyData", e));
	pty.on("exit", (e) => {
		emitter.emit("ptyExit", e);
		permissions.settle(e.terminalId);
		// Record the exit in the DB so a session is never left looking "running"
		// after its process is gone — the gap that previously stranded cards in
		// the running column. Code that needs liveness must ask the PTY daemon
		// (pty.has), not this status.
		// The pane is gone, so a follow-up armed for it can never be delivered.
		followUps.discard(e.terminalId);
		const session = repo.getSessionByTerminal(db, e.terminalId);
		if (!session) return;
		// A message still waiting for this task now goes in by launch.
		queueMicrotask(() => peers.kick(session.taskId));
		// `closed` is stamped by the kill handler before the PTY goes; anything
		// else reaching here ended on its own. Either way the tab is not coming
		// back on its own, so neither is offered as restorable.
		if (session.exitedAt == null) {
			// A reap is the app reclaiming an idle process, not news: the card must
			// not claim the user has something new to look at because a timer fired.
			const reaped = session.exitReason === "reaped";
			applyAgentExit(
				session.id,
				session.taskId,
				Date.now(),
				!reaped,
				session.exitReason ?? "exited",
			);
		}
	});

	// The backstop for exits nobody watched. The daemon outlives the app, so an
	// agent that finishes while the app is closed broadcasts to no one and is
	// then dropped from the daemon's map — leaving its card in `running` for
	// good. Every connect hands us the daemon's live set, which is exactly the
	// evidence needed to close those out. See pty/stranded.ts for why this is
	// scoped to sessions predating this engine.
	// Marking them `stranded` is also what lets the panel offer them back as
	// tabs — see pty/reconcile.ts for the once-per-run rule that keeps that set
	// to "what was open at shutdown".
	const reconcileStranded = makeStrandReconciler(db, engineStartedAt, (s) => {
		// Best guess at when it died: we only know it was gone by now.
		applyAgentExit(s.id, s.taskId, Date.now(), false, "stranded");
	});
	pty.on("attached", (terminals: { terminalId: string }[]) => {
		const live = new Set(terminals.map((t) => t.terminalId));
		const open = repo.listOpenSessions(db);
		const stranded = reconcileStranded(live);
		// Always log: this is a bulk mutation of the board, so "it did nothing"
		// has to be as visible as "it closed 700 cards". The desktop passes no
		// `log`, so fall back to console like LoopRunner does.
		const log = opts.log ?? ((line: string) => console.log(line));
		log(
			`[ateam] pty attach: ${live.size} live, ${open.length} open in db → closed ${stranded.length}`,
		);
	});

	// With an OpenRouter key, Jev may re-file a finished turn the rule filed in
	// Review (turn-classifier.ts). Without one it never calls out.
	const turns = createTurnClassifier({ db, notifyTaskUpdated: sendTaskUpdated, log: opts.log });

	// Agent status hooks → update session/task, drive the kanban column.
	hooks.on("hook", (e: HookEvent) => {
		const session = repo.getSessionByTerminal(db, e.terminalId);
		if (!session) return;
		// The agent moving on means a prompt held for an Ateam client was answered
		// in its terminal (or abandoned): take that card down. Its own
		// PermissionRequest notification is not moving on.
		if (e.eventType !== "PermissionRequest" && e.eventType !== "BrowserUse")
			permissions.settle(e.terminalId, e.eventType);
		// The agent called a browser tool. Its Working fires alongside and drives
		// the status, so this only stamps the task.
		if (e.eventType === "BrowserUse") {
			if (stampBrowserUse(db, session.taskId)) sendTaskUpdated(session.taskId);
			return;
		}
		if (e.eventType === "AgentExit") {
			repo.recordEvent(db, {
				sessionId: session.id,
				terminalId: e.terminalId,
				eventType: e.eventType,
				rawAgentSessionId: null,
			});
			// The agent quit and its pane lives on as a shell (see pty/agent-quit.ts).
			// Its follow-up can never be delivered now.
			followUps.discard(e.terminalId);
			const taskId = applyAgentQuit(db, pty, session);
			if (taskId) sendTaskUpdated(taskId);
			peers.kick(session.taskId);
			return;
		}
		const status = sessionStatusAfter(e.eventType, session.status);
		repo.updateSession(db, session.id, {
			status,
			lastEventAt: Date.now(),
		});
		// "Working" fires on every tool use — too chatty for the append-only
		// event log; it only needs to drive status/column.
		if (e.eventType !== "Working") {
			repo.recordEvent(db, {
				sessionId: session.id,
				terminalId: e.terminalId,
				eventType: e.eventType,
				rawAgentSessionId: e.sessionId ?? null,
			});
		}
		// A Start is the process coming up, not the conversation doing anything:
		// it fires on `--resume` (and on compaction) exactly as on a fresh launch.
		// A fresh launch already filed the card as running when it spawned, and
		// its first Working follows within seconds; a resume sits idle at the
		// prompt and must not move the card or refresh its "last activity".
		if (e.eventType === "Start") return;
		const task = repo.getTask(db, session.taskId);
		if (task) {
			// Activity brings an archived task back, whatever the event: the early
			// returns below skip the write for a Working that changes nothing, and
			// leave lastEventAt old, so restoredAt is what holds off the sweep.
			if (task.archivedAt != null) {
				repo.updateTask(db, task.id, { archivedAt: null, restoredAt: Date.now() });
				sendTaskUpdated(task.id);
			}
			// A pending question holds the card in Needs You whatever this says
			// (repo.updateTask), so a Stop cannot bury it in Review.
			const column = mapEventToColumn(e.eventType);
			// Subagents fire PreToolUse too, so a Working event must never mask a
			// pending question — only an explicit user reply (UserReply), Stop, or
			// a fresh Start may move a task out of needs_attention.
			if (e.eventType === "Working" && task.column === "needs_attention") {
				return;
			}
			// Skip no-op Working updates so the renderer isn't pinged per tool use.
			if (e.eventType === "Working" && task.column === column && task.agentStatus === status) {
				return;
			}
			// Only a Stop is ever suppressed, so only a Stop pays for the lookup:
			// `Working` fires on every tool use and must not hit the loops table.
			const ownedByLoop = e.eventType === "Stop" && repo.loopForTask(db, task.id) !== undefined;
			// The user typing into a task whose wait already resurfaced is the one
			// hook event that ends it: they came back to it. A wait still pending is
			// left alone, since chatting in the task says nothing about the outside
			// party it waits on. See waits.ts.
			const cameBack = e.eventType === "UserReply" && isFiredWait(task);
			repo.updateTask(db, task.id, {
				agentStatus: status,
				column,
				lastEventAt: Date.now(),
				// Working/Start mean the user just interacted or launched — the
				// task isn't "unread"; Stop/PermissionRequest are news for them,
				// unless the Stop is just a loop's tick ending on schedule.
				isUnread: mapEventToUnread(e.eventType, ownedByLoop),
				...(cameBack ? CLEAR_WAIT : {}),
				// The user typed into the task: that is their answer to its question.
				...(e.eventType === "UserReply" && task.question ? CLEAR_QUESTION : {}),
				// What the Lead chat reads back (tasks:lastReply).
				...(e.eventType === "Stop" && e.lastAssistantMessage
					? { lastReply: e.lastAssistantMessage, lastReplyAt: Date.now() }
					: {}),
			});
			sendTaskUpdated(task.id);
			if (e.eventType === "UserReply" && e.prompt) turns.userReplied(task.id, e.prompt);
			// Every Stop, message or not: it also retires any verdict still in
			// flight for the previous turn.
			if (e.eventType === "Stop") void turns.turnEnded(task.id, e.lastAssistantMessage);
			// A turn ending is when a message held for a busy agent can go in.
			if (e.eventType === "Stop") peers.kick(task.id);
		}
	});

	// Reclaim agents that finished their turn and went quiet (see pty/reap.ts).
	// Stamp the ending BEFORE the kill, exactly as the close-tab handler does:
	// the exit handler above reads it back, and `reaped` is what puts the tab on
	// the restorable strip instead of retiring it to history.
	// Refresh git + PR facts for tasks nobody is looking at, so a list row can
	// say something true about a worktree whose panel was never opened.
	const taskIsLive = (taskId: string): boolean =>
		repo.listSessionsByTask(db, taskId).some((s) => pty.has(s.terminalId));
	const worktreeSweep = createWorktreeSweep({
		db,
		onTaskUpdated: (taskId) => sendTaskUpdated(taskId),
		isLive: taskIsLive,
	});

	let reapTimer: ReturnType<typeof setInterval> | null = null;
	let archiveTimer: ReturnType<typeof setInterval> | null = null;
	// Take open tasks idle past `engine.archiveAfterDays` off every board (see
	// archive.ts). Read per pass, so a settings edit applies at the next one.
	const archiveIdle = (): void => {
		const ids = archiveIdleTasks(
			{ db, isLive: taskIsLive },
			readSettings().settings.engine.archiveAfterDays,
		);
		for (const id of ids) emitter.emit("taskRemoved", id);
		if (ids.length > 0) {
			const log = opts.log ?? ((line: string) => console.log(line));
			log(`[ateam] archived ${ids.length} idle task(s)`);
		}
	};
	const reapIdleSessions = (): void => {
		const due = reapableSessions(repo.listOpenSessions(db), Date.now(), REAP_IDLE_MS);
		let count = 0;
		for (const s of due) {
			// Already gone: its exit is the live path's to record, not ours.
			if (!pty.has(s.terminalId)) continue;
			repo.demoteReapedSessions(db, s.taskId);
			repo.updateSession(db, s.id, { exitReason: "reaped" });
			pty.kill(s.terminalId);
			count += 1;
		}
		if (count > 0) {
			const log = opts.log ?? ((line: string) => console.log(line));
			log(`[ateam] reaped ${count} idle session(s) — restorable from their tabs`);
		}
	};

	// Agent ran `gh pr merge` in its terminal → the gh shim routed it here.
	// Resolve the task from the terminal and enqueue, so terminal merges and the
	// in-app Merge button share one serialized queue per base branch. The outcome
	// goes back to the shim, so the agent reads it in its own terminal.
	hooks.setMergeHandler(async (e: MergeRequestEvent) => {
		const session = repo.getSessionByTerminal(db, e.terminalId);
		if (!session) return null;
		const task = repo.getTask(db, session.taskId);
		if (!task) return null;
		const project = repo.getProject(db, task.projectId);
		if (!project) return null;
		const { engine: settings } = readSettings().settings;
		const requested = e.strategy ?? "";
		const strategy = (
			["merge", "squash", "rebase"].includes(requested) ? requested : settings.defaultMergeStrategy
		) as MergeStrategy;
		return mergeQueue.enqueue({
			task,
			repoPath: project.repoPath,
			strategy,
			updateStrategy: settings.defaultUpdateStrategy,
			deleteRemoteBranch: settings.deleteRemoteBranchOnMerge,
		});
	});

	// Timers for waits that were armed before this process started.
	waits.start();

	return {
		services,
		on(event, listener) {
			emitter.on(event, listener as (...a: unknown[]) => void);
			return () => emitter.off(event, listener as (...a: unknown[]) => void);
		},
		sendTaskUpdated,
		worktreeSweep,
		sendTaskRemoved(taskId: string) {
			emitter.emit("taskRemoved", taskId);
		},
		sendLoopsUpdated() {
			emitter.emit("loopsUpdated", loopRunner.describe());
		},
		messageFrom: (sender, req) => peers.sendFrom(sender, req),
		answerQuestion: (req) => {
			// A permission prompt is answered by resolving the hook that holds it,
			// not by a message: the agent is mid-turn, waiting on exactly this.
			if (permissions.holds(req.questionId)) return permissions.answer(req.questionId, req.answer);
			const q = repo.getTask(db, req.taskId)?.question;
			if (q?.kind === "permission" || q?.kind === "askUserQuestion")
				throw new Error("That prompt is no longer waiting. Answer it in the task's terminal.");
			return answerQuestion(db, (sender, r) => peers.sendFrom(sender, r), req, sendTaskUpdated);
		},
		async connectPty() {
			try {
				await pty.connect();
			} finally {
				// A daemon that can't be reached leaves calls to answer without one.
				markPtyReady();
			}
		},
		ptyReady: () => ptyReady,
		startLoops() {
			loopRunner.start();
			reapTimer ??= setInterval(reapIdleSessions, REAP_SWEEP_MS);
			// Liveness needs the daemon: before it answers, every terminal reads as gone.
			if (!archiveTimer) {
				archiveTimer = setInterval(archiveIdle, ARCHIVE_SWEEP_MS);
				void ptyReady.then(archiveIdle);
			}
			worktreeSweep.start();
			peers.start();
		},
		isWorking() {
			if (pendingSeeds.size > 0 || mergeQueue.busy()) return true;
			// The row's status says mid-turn; the daemon says the process is still
			// there (a row can strand at "running" after an exit nobody watched).
			return repo
				.listOpenSessions(db)
				.some((s) => s.status === "running" && s.agentId !== "shell" && pty.has(s.terminalId));
		},
		stop() {
			pty.disconnect();
			hooks.stop();
			loopRunner.stop();
			worktreeSweep.stop();
			if (reapTimer) {
				clearInterval(reapTimer);
				reapTimer = null;
			}
			if (archiveTimer) {
				clearInterval(archiveTimer);
				archiveTimer = null;
			}
			waits.stop();
			peers.stop();
			permissions.stop();
		},
		stopHooks() {
			hooks.stop();
		},
	};
}
