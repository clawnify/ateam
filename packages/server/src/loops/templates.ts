import { join } from "node:path";
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
 * Where a loop keeps its notes between runs, relative to the worktree root.
 * Under `.ateam/`, which `ensureWorktreesIgnored` already adds to the repo's
 * local exclude file, so it never shows in `git status` and never flips the
 * card's triage to "uncommitted".
 */
const STATE_FILE = ".ateam/loop-state.md";

/**
 * Prepended to every tick's prompt. A loop runs unattended and each tick is a
 * fresh process with fresh context, so a run that learns something has nowhere
 * to put it — the only thing that outlives the run is the worktree.
 *
 * A named file rather than a harness feature, on purpose. Claude Code's auto
 * memory already does this well and does it unprompted, but it is Claude-only
 * (codex and opencode have no equivalent) and is keyed to the repository rather
 * than the loop, so it is shared with every other task on that repo. A file in
 * the loop's own worktree is agent-agnostic, scoped to this loop, and sits at a
 * path the app can read.
 *
 * Note what it does NOT say: "write this when you finish". A run may rewrite the
 * file several times, and a tick ending is not a promise that the last write
 * happened — a run that parks on a question has still learned something worth
 * leaving behind.
 */
function stateInstructions(worktreePath: string): string {
	// ABSOLUTE, not "relative to the repository root". Inside a linked worktree
	// that phrase has two defensible readings, and `.ateam/` exists at BOTH
	// levels — the main checkout's holds `worktrees/` — so the wrong reading
	// lands somewhere plausible instead of failing. One loop resolved it to the
	// main repo and every other loop on that repo then shared one file; the next
	// run to notice had to reason its way around a collision at runtime.
	const file = join(worktreePath, STATE_FILE);
	return [
		`This is one run of a recurring loop, not a one-off task. Earlier runs leave notes in \`${file}\`; read it before you start. The repository itself is the source of truth — treat that file as a hint about where the last run stopped, not as fact.`,
		`That file is this loop's alone. Do not read or write a \`${STATE_FILE}\` anywhere else, and never one outside this worktree — another loop's notes live there.`,
		`Whenever you learn something a later run would otherwise have to rediscover, rewrite \`${file}\` in place (rewrite, do not append): what exists now, what this run did, what is next, and what is blocked. Keep it under 40 lines. Write it as you go, including before you stop to ask a question — not only when you finish.`,
	].join("\n\n");
}

/**
 * How long a session may go silent before a tick stops treating its agent as
 * working.
 *
 * Deliberately generous, because the two failure costs are lopsided: too short
 * kills real work (a single long tool call — a build, a test suite — emits no
 * hook event while it runs), while too long only delays a latched loop's
 * self-healing, which Run now already cuts through instantly.
 *
 * The honest caveat: this cannot be measured from what we store. `Working` is
 * the event a busy agent emits, and it is deliberately excluded from the
 * `agent_events` log (see the hook handler), while `agent_sessions.lastEventAt`
 * is overwritten in place — so no history of the working cadence exists. Two
 * hours is chosen to sit beyond any plausible single tool call, not from data.
 */
const AGENT_SILENT_MS = 2 * 60 * 60 * 1000;

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

		// Don't cut off an agent that is genuinely mid-flight. The branch below
		// kills the previous pane before spawning, so this is not about overlap:
		// it is only about not interrupting real work.
		//
		// Status and a live PTY are both necessary and neither is sufficient, which
		// is why the old two-condition version latched every long-lived loop:
		//   * a live PTY is not a live agent — a pane runs `<agent>; exec $SHELL -l`
		//     (see spawnAgentInTask), so it outlives the agent by design;
		//   * and a status can strand when the exit went unobserved.
		// With only those two, the guard is self-perpetuating: a skipped tick
		// spawns nothing, so no hook fires, so the status that caused the skip can
		// never change. Every loop here sat wedged for ~20 hours that way.
		//
		// Recency is what bounds it. `updateSession` stamps the SESSION row on
		// every hook event, including the per-tool-use `Working` that the task row
		// skips for no-op updates, so a working agent keeps this fresh while a
		// stranded one goes quiet. `awaiting_input` stays in scope on purpose: a
		// prompt you are about to answer deserves the same protection as a running
		// turn, and a day-old one gets none because it is no longer recent.
		//
		// A manual Run now overrides all of it — the user asked, and can see what
		// it replaced.
		if (task && !ctx.manual) {
			const active = task.agentStatus === "running" || task.agentStatus === "awaiting_input";
			const working = active && ctx.isTaskAgentLive(task.id);
			const lastHeard = Math.max(
				0,
				// A session that just spawned has no hook event yet; its start counts.
				...repo.listSessionsByTask(ctx.db, task.id).map((s) => s.lastEventAt ?? s.startedAt ?? 0),
			);
			if (working && Date.now() - lastHeard < AGENT_SILENT_MS) {
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
			// Record the loop's own prompt as the task's description before the
			// launch can: description is the task's record of intent and feeds the
			// LLM tagger and search (see spawnAgentInTask / tagTaskInBackground),
			// so the state instructions must never end up in it.
			repo.updateTask(ctx.db, task.id, { description: prompt });
		} else {
			// Close the previous run's idle pane so panes don't accumulate as
			// terminal tabs; the agent's own conversation history stays in the
			// worktree (resumable from the agent CLI).
			ctx.stopTaskSessions(task.id);
		}

		// Claim the task BEFORE the launch, not after. The loop owns one task for
		// its whole life, and this link is the only record of which one; writing
		// it after the spawn means a launch that throws (the agent's CLI is gone
		// from this machine — see spawnAgentInTask) leaves the loop unlinked, so
		// the NEXT tick builds another branch and worktree, and the one after
		// that another. A failed run must cost nothing but the failure.
		if (loopId && row) {
			// Persist the link under `taskId`; drop the legacy key it migrated from.
			const { lastTaskId: _legacy, ...rest } = row.config ?? {};
			repo.updateLoop(ctx.db, loopId, { config: { ...rest, taskId: task.id } });
		}

		await ctx.spawnAgent({
			taskId: task.id,
			agentId,
			prompt: `${stateInstructions(task.worktreePath)}\n\n---\n\n${prompt}`,
			followUp,
		});
		return { summary: `run ${runNumber} started (${task.name})` };
	},
};

export const LOOP_TEMPLATES: LoopTemplate[] = [agentSession];

export function getTemplate(id: string): LoopTemplate | undefined {
	return LOOP_TEMPLATES.find((t) => t.id === id);
}
