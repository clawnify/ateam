import type { AteamDb } from "@ateam/db";

/** A global loop runs once for the whole app; a per-task loop runs per task. */
export type LoopScope = "global" | "per_task";

/**
 * How often a loop runs. `fixed` is a steady interval; `self_paced` lets each
 * run choose the next delay within bounds (modeled on Claude Code's `/loop`:
 * tight while work is active, loose when quiet, and able to end itself).
 */
export type LoopCadence =
	| { mode: "fixed"; everyMs: number }
	| { mode: "self_paced"; minMs: number; maxMs: number };

/** The session capabilities a loop run gets, wired in by the engine. */
export interface LoopSessionOps {
	/** Create a task (branch + worktree + row) in a project — the composer's flow. */
	createTask: (input: { projectId: string; name: string }) => Promise<{ taskId: string }>;
	/** Launch a coding agent with a prompt in an existing task. */
	spawnAgent: (input: {
		taskId: string;
		agentId: string;
		prompt: string;
		/** Optional second turn, taken right after the first response. */
		followUp?: string;
	}) => Promise<{ terminalId: string }>;
	/** Kill a task's live PTYs (the previous run's idle pane). */
	stopTaskSessions: (taskId: string) => void;
	/**
	 * Whether a task still has a live agent PTY. Ground truth from the daemon —
	 * unlike the persisted agentStatus, which can strand at "running" when an
	 * exit happened while the app was closed. Guards must use this, or a stale
	 * status would wedge a loop forever.
	 */
	isTaskAgentLive: (taskId: string) => boolean;
}

/** Services and helpers handed to a loop on each run. */
export interface LoopContext extends LoopSessionOps {
	db: AteamDb;
	/** Emit a diagnostic line (prefixed with the loop id by the runner). */
	log: (message: string) => void;
}

/** What a single loop run reports back to the runner. */
export interface LoopOutcome {
	/** One-line summary of what this run did, shown in the Loops panel. */
	summary?: string;
	/**
	 * Preferred delay before the next run, for `self_paced` loops. The runner
	 * clamps it to `[minMs, maxMs]`. Ignored for `fixed` loops.
	 */
	nextDelayMs?: number;
	/** The loop is finished and should stop and remove itself (watcher loops). */
	done?: boolean;
}

/**
 * A loop definition lives in code and is registered with the LoopRunner. Its
 * persisted runtime state (enabled flag, last-run telemetry) lives in the
 * `loops` DB table so it survives restarts and the UI can show/toggle/run-now.
 */
export interface LoopDefinition {
	id: string;
	title: string;
	description: string;
	scope: LoopScope;
	cadence: LoopCadence;
	/** Whether a freshly-created instance starts enabled. Defaults to true. */
	enabledByDefault?: boolean;
	/** Run one pass. Throwing is caught and recorded as an error. */
	run(ctx: LoopContext): Promise<LoopOutcome>;
}
