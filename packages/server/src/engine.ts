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
import { createDb, repo } from "@ateam/db";
import type {
	AgentStatus,
	KanbanColumn,
	LoopDTO,
	MergeStrategy,
	PtyDataEvent,
	PtyExitEvent,
	TaskDTO,
} from "@ateam/protocol";
import { ensureGhShim, ensureNotifyScript } from "./agent-setup";
import { type HookEvent, HookServer, type MergeRequestEvent } from "./hooks/hook-server";
import { createBoardReconciler } from "./loops/board-reconciler";
import { applySetStatus, buildBoardView } from "./loops/board-signals";
import { LoopRunner } from "./loops/runner";
import { MergeQueue } from "./merge-queue";
import { PtyClient } from "./pty/pty-client";
import { type Services, toTaskDTO } from "./services";

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
	/** Connect to (or launch) the detached PTY daemon and learn live sessions. */
	connectPty(): Promise<void>;
	/** Start the periodic reconciler loops. */
	startLoops(): void;
	/** Detach the client and stop hooks/loops — never kills PTY sessions. */
	stop(): void;
	/** Stop just the hook server (used by the headless smoke check). */
	stopHooks(): void;
}

function mapEventToStatus(eventType: string): AgentStatus {
	if (eventType === "PermissionRequest") return "awaiting_input";
	if (eventType === "Stop") return "idle";
	return "running";
}

function mapEventToColumn(eventType: string): KanbanColumn {
	if (eventType === "PermissionRequest") return "needs_attention";
	if (eventType === "Stop") return "review";
	return "running";
}

export async function createEngine(opts: EngineOptions): Promise<Engine> {
	const { dataDir, daemonPath, execPath } = opts;
	const emitter = new EventEmitter();

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

	const sendTaskUpdated = (taskId: string): void => {
		const task = repo.getTask(db, taskId);
		if (task) emitter.emit("taskUpdated", toTaskDTO(task));
	};

	// The detached PTY daemon survives restarts; daemonPath is run via execPath as
	// node (ELECTRON_RUN_AS_NODE on the desktop) so node-pty's ABI matches.
	const pty = new PtyClient(
		daemonPath,
		opts.sockPath ?? join(homedir(), ".ateam", "pty-daemon.sock"),
		execPath,
	);
	const hooks = new HookServer();
	const hookPort = await hooks.start(repo.getSettings(db).hookPort ?? undefined);
	const notifyScriptPath = await ensureNotifyScript(dataDir);
	await ensureGhShim(dataDir);
	const hooksDir = join(dataDir, "hooks");
	repo.updateSettings(db, { hookPort });

	const mergeQueue = new MergeQueue({ db, onTaskUpdated: sendTaskUpdated });
	const loopRunner = new LoopRunner({
		db,
		onTaskUpdated: sendTaskUpdated,
		log: opts.log ?? ((line) => console.log(line)),
		mergeQueue,
	});
	loopRunner.register(createBoardReconciler());

	// Board Organizer tools: the organizer loop's headless `claude -p` turn reads
	// the board and proposes moves through these, guarded by validateSetStatus.
	hooks.setBoardHandlers({
		get: () => buildBoardView(db),
		setStatus: async (req) => applySetStatus(db, req, sendTaskUpdated),
	});

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
	};

	// PTY output/exit → emitted for the transport to forward.
	pty.on("data", (e) => emitter.emit("ptyData", e));
	pty.on("exit", (e) => {
		emitter.emit("ptyExit", e);
		// Record the exit in the DB so a session is never left looking "running"
		// after its process is gone — the gap that previously stranded cards in
		// the running column (the board reconciler is the backstop for exits we
		// miss entirely, e.g. while the app was closed).
		const session = repo.getSessionByTerminal(db, e.terminalId);
		if (!session) return;
		if (session.exitedAt == null) {
			repo.updateSession(db, session.id, {
				status: "stopped",
				exitedAt: Date.now(),
			});
		}
		const task = repo.getTask(db, session.taskId);
		if (task && task.column === "running") {
			repo.updateTask(db, task.id, {
				agentStatus: "stopped",
				column:
					task.prNumber != null || (task.gitStatus?.ahead ?? 0) > 0 ? "review" : "needs_attention",
				isUnread: true,
			});
			sendTaskUpdated(task.id);
		}
	});

	// Agent status hooks → update session/task, drive the kanban column.
	hooks.on("hook", (e: HookEvent) => {
		const session = repo.getSessionByTerminal(db, e.terminalId);
		if (!session) return;
		const status = mapEventToStatus(e.eventType);
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
		const task = repo.getTask(db, session.taskId);
		if (task) {
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
			repo.updateTask(db, task.id, {
				agentStatus: status,
				column,
				lastEventAt: Date.now(),
				// Working/Start mean the user just interacted or launched — the
				// task isn't "unread"; Stop/PermissionRequest are news for them.
				isUnread: e.eventType === "Stop" || e.eventType === "PermissionRequest",
			});
			sendTaskUpdated(task.id);
		}
	});

	// Agent ran `gh pr merge` in its terminal → the gh shim routed it here.
	// Resolve the task from the terminal and enqueue, so terminal merges and the
	// in-app Merge button share one serialized queue per base branch.
	hooks.on("merge-request", (e: MergeRequestEvent) => {
		const session = repo.getSessionByTerminal(db, e.terminalId);
		if (!session) return;
		const task = repo.getTask(db, session.taskId);
		if (!task) return;
		const project = repo.getProject(db, task.projectId);
		if (!project) return;
		const settings = repo.getSettings(db);
		const requested = e.strategy ?? "";
		const strategy = (
			["merge", "squash", "rebase"].includes(requested)
				? requested
				: (settings.defaultMergeStrategy ?? "squash")
		) as MergeStrategy;
		void mergeQueue.enqueue({
			task,
			repoPath: project.repoPath,
			strategy,
			updateStrategy: settings.defaultUpdateStrategy ?? "merge",
			deleteRemoteBranch: settings.deleteRemoteBranchOnMerge ?? false,
		});
	});

	return {
		services,
		on(event, listener) {
			emitter.on(event, listener as (...a: unknown[]) => void);
			return () => emitter.off(event, listener as (...a: unknown[]) => void);
		},
		sendTaskUpdated,
		sendTaskRemoved(taskId: string) {
			emitter.emit("taskRemoved", taskId);
		},
		sendLoopsUpdated() {
			emitter.emit("loopsUpdated", loopRunner.describe());
		},
		async connectPty() {
			await pty.connect();
		},
		startLoops() {
			loopRunner.start();
		},
		stop() {
			pty.disconnect();
			hooks.stop();
			loopRunner.stop();
		},
		stopHooks() {
			hooks.stop();
		},
	};
}
