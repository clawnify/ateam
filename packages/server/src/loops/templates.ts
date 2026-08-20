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
 * Agent session — the one loop kind. On each tick it creates a fresh task in
 * the loop's project (own branch + worktree, named "<loop> #<run>") and
 * launches the chosen coding agent with the same prompt, exactly like typing
 * it in the composer. A tick is skipped while the previous run's agent is
 * still working, so slow runs never pile up worktrees. Because the loop row
 * lives in one engine's database, WHERE it runs is simply where it was
 * created — this Mac or a box.
 */
const agentSession: LoopTemplate = {
	id: "agent-session",
	title: "Agent session",
	description: "Starts a coding-agent session with the same prompt in a fresh task, on a schedule.",
	defaultCadence: { mode: "fixed", everyMs: 3_600_000 },
	params: [
		{ key: "prompt", label: "Prompt", type: "string", default: "" },
		{ key: "agentId", label: "Agent", type: "string", default: "claude" },
	],
	build: (config) => async (ctx) => {
		const prompt = str(config.prompt)?.trim();
		const projectId = str(config.projectId);
		const agentId = str(config.agentId) ?? "claude";
		if (!prompt) throw new Error("Loop has no prompt");
		if (!projectId) throw new Error("Loop has no project");
		// The runner injects the row id so a run can read/update its own record.
		const loopId = str(config.loopId);
		const row = loopId ? repo.getLoop(ctx.db, loopId) : undefined;

		// Never overlap runs: while the previous run's agent is still working
		// (or waiting on the user), skip this tick instead of stacking tasks.
		// Require a LIVE PTY, not just the persisted status — agentStatus can
		// strand at "running" when the exit happened while the app was closed,
		// and a status-only check would wedge the loop forever.
		const lastTaskId = str(row?.config?.lastTaskId);
		if (lastTaskId) {
			const prev = repo.getTask(ctx.db, lastTaskId);
			const activeStatus =
				prev?.agentStatus === "running" || prev?.agentStatus === "awaiting_input";
			if (prev && activeStatus && ctx.isTaskAgentLive(prev.id)) {
				return { summary: `previous run still active (${prev.name}) — skipped` };
			}
		}

		const runNumber = (row?.runs ?? 0) + 1;
		const name = `${row?.name ?? "Loop"} #${runNumber}`;
		const { taskId } = await ctx.startAgentRun({ projectId, name, agentId, prompt });
		if (loopId && row) {
			repo.updateLoop(ctx.db, loopId, { config: { ...row.config, lastTaskId: taskId } });
		}
		return { summary: `started ${name}` };
	},
};

export const LOOP_TEMPLATES: LoopTemplate[] = [agentSession];

export function getTemplate(id: string): LoopTemplate | undefined {
	return LOOP_TEMPLATES.find((t) => t.id === id);
}
