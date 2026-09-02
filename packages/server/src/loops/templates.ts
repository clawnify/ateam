import { repo } from "@ateam/db";
import type { LoopCadence, LoopContext, LoopOutcome } from "./types";

/** A configurable parameter a user sets when creating a loop from a template. */
export interface LoopTemplateParam {
	key: string;
	label: string;
	type: "number" | "boolean" | "string";
	default: number | boolean | string;
	help?: string;
}

/**
 * A code-side recipe a user instantiates into a concrete loop. The instance's
 * name, project scope, cadence, and param values are persisted in the `loops`
 * table; `build` turns the stored config into the actual run function.
 */
export interface LoopTemplate {
	id: string;
	title: string;
	description: string;
	defaultCadence: LoopCadence;
	params: LoopTemplateParam[];
	build(config: Record<string, unknown>): (ctx: LoopContext) => Promise<LoopOutcome>;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Agent session — the one loop kind, with cron semantics: the loop owns ONE
 * persistent task (branch + worktree, created lazily on the first run), and
 * every tick starts a FRESH agent session in it with the same prompt — a fixed
 * working directory, a new process each time. Runs never mint new tasks, so a
 * loop is one card on the board however long it lives. A tick is skipped while
 * the previous run's agent is still working; otherwise the previous idle pane
 * is closed so terminals don't pile up as tabs. Because the loop row lives in
 * one engine's database, WHERE it runs is simply where it was created — this
 * Mac or a box.
 */
const agentSession: LoopTemplate = {
	id: "agent-session",
	title: "Agent session",
	description:
		"Starts a coding-agent session with the same prompt in the loop's own task, on a schedule.",
	defaultCadence: { mode: "fixed", everyMs: 3_600_000 },
	params: [
		{ key: "prompt", label: "Prompt", type: "string", default: "" },
		{ key: "agentId", label: "Agent", type: "string", default: "claude" },
		{
			key: "followUp",
			label: "Follow-up",
			type: "string",
			default: "",
			help: "Sent once, after the agent's first reply. A slash command or a sentence.",
		},
	],
	build: (config) => async (ctx) => {
		const prompt = str(config.prompt)?.trim();
		const projectId = str(config.projectId);
		const agentId = str(config.agentId) ?? "claude";
		// Optional: the agent takes one more turn on this the moment its first
		// response lands. Empty means the run is a single turn, as before.
		const followUp = str(config.followUp)?.trim();
		if (!prompt) throw new Error("Loop has no prompt");
		if (!projectId) throw new Error("Loop has no project");
		// The runner injects the row id so a run can read/update its own record.
		const loopId = str(config.loopId);
		const row = loopId ? repo.getLoop(ctx.db, loopId) : undefined;

		// The loop's persistent task. Loops from the fresh-task-per-run era
		// stored the newest run's task as `lastTaskId` — that task simply
		// becomes the persistent one (free migration).
		const linkedId = str(row?.config?.taskId) ?? str(row?.config?.lastTaskId);
		let task = linkedId ? repo.getTask(ctx.db, linkedId) : undefined;

		// Never overlap runs: while the previous run's agent is still working
		// (or waiting on the user), skip this tick. Require a LIVE PTY, not
		// just the persisted status — agentStatus can strand at "running" when
		// the exit happened while the app was closed, and a status-only check
		// would wedge the loop forever.
		if (task) {
			const activeStatus = task.agentStatus === "running" || task.agentStatus === "awaiting_input";
			if (activeStatus && ctx.isTaskAgentLive(task.id)) {
				return { skipped: true, summary: `previous run still active (${task.name}) — skipped` };
			}
		}

		const runNumber = (row?.runs ?? 0) + 1;
		if (!task) {
			// First run (or the task was cleaned up): create the loop's task.
			const name = row?.name ?? "Loop";
			let created: { taskId: string };
			try {
				created = await ctx.createTask({ projectId, name });
			} catch {
				// A branch/worktree from a removed incarnation is still around
				// (`git worktree add -b` refuses an existing branch) — take a
				// deterministic fresh name instead of failing the run.
				created = await ctx.createTask({ projectId, name: `${name} ${runNumber}` });
			}
			task = repo.getTask(ctx.db, created.taskId);
			if (!task) throw new Error("Task creation failed");
		} else {
			// Close the previous run's idle pane so panes don't accumulate as
			// terminal tabs; the agent's own conversation history stays in the
			// worktree (resumable from the agent CLI).
			ctx.stopTaskSessions(task.id);
		}

		await ctx.spawnAgent({ taskId: task.id, agentId, prompt, followUp });
		if (loopId && row) {
			// Persist the link under `taskId`; drop the legacy key it migrated from.
			const { lastTaskId: _legacy, ...rest } = row.config ?? {};
			repo.updateLoop(ctx.db, loopId, { config: { ...rest, taskId: task.id } });
		}
		return { summary: `run ${runNumber} started (${task.name})` };
	},
};

export const LOOP_TEMPLATES: LoopTemplate[] = [agentSession];

export function getTemplate(id: string): LoopTemplate | undefined {
	return LOOP_TEMPLATES.find((t) => t.id === id);
}
