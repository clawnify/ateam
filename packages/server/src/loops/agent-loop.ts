/**
 * Agent-driven prompt loops — the "keep the agent going until done" primitive,
 * distinct from the reconciler loops in this directory (board-reconciler etc.).
 *
 * A reconciler loop is an app-side timer that does deterministic bookkeeping and
 * NEVER touches the agent. An agent loop is the opposite: it re-drives the agent
 * itself on its own rhythm — the `/loop` analogue — so a task keeps iterating
 * (test-fix, TODO burndown, "keep going until X") without a human retyping
 * "continue".
 *
 * We deliberately do NOT re-invent a scheduler for this: every agent already
 * exposes a native seam for it, and the binding differs per agent (see
 * agent-loops.design.md). What they SHARE is the decision this module owns:
 * given a loop's config and how many turns it has taken, should the agent take
 * another turn, and with what prompt? Keeping that one decision pure and
 * agent-agnostic is what lets the Codex `Stop`-hook, the OpenCode `session.idle`
 * plugin, and the Claude native `/loop` all be thin bindings over the same brain.
 *
 * Pure module: no db, no electron, no I/O. Unit-tested in
 * apps/desktop/test/agent-loop.test.ts.
 */

/**
 * A hard cap on turns is MANDATORY, not optional. None of the three agents
 * guarantees loop termination for us — Codex's own docs note "infinite loops
 * would have to be prevented by your own logic", Claude's `/loop` expires only
 * after 7 days, and OpenCode has no native stop at all. The cap is the backstop
 * that makes an agent loop safe to hand to any of them.
 */
export const DEFAULT_MAX_ITERATIONS = 25;

/** An absolute ceiling a user-supplied cap is clamped to — defense in depth. */
export const HARD_MAX_ITERATIONS = 1000;

/**
 * What a user configures when they attach a loop to a task. Persisted (as the
 * `config` JSON on the loop row) and reused by every binding: the two
 * hook-driven bindings feed it to `decideContinuation` each turn; the Claude
 * binding uses it to compose the native `/loop` command it launches.
 */
export interface AgentLoopConfig {
	/** The instruction re-sent to the agent at the start of each new turn. */
	prompt: string;
	/**
	 * Safety backstop: stop after this many turns no matter what. Clamped to
	 * `[1, HARD_MAX_ITERATIONS]`; omitted → DEFAULT_MAX_ITERATIONS.
	 */
	maxIterations?: number;
	/**
	 * Optional goal sentinel. If set, the loop ends the moment the agent's last
	 * turn output contains this exact string — the agent declares itself done by
	 * printing it (e.g. instruct it to emit `LOOP_DONE` when the task is
	 * complete). Without it, the loop runs until the iteration cap.
	 */
	stopSignal?: string;
}

/** Mutable per-loop runtime, tracked alongside the config. */
export interface AgentLoopState {
	/** Turns the agent has already taken for this loop (0 on first decision). */
	iterations: number;
}

/** The verdict for one turn boundary. */
export type LoopDecision =
	| { continue: true; prompt: string; reason: string }
	| { continue: false; reason: string };

/** Why a loop stopped — useful for the Loops panel summary and telemetry. */
export type StopReason = "goal_reached" | "max_iterations" | "empty_prompt";

/** Clamp a configured cap into the safe range. */
export function resolveMaxIterations(config: AgentLoopConfig): number {
	const raw = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
	if (!Number.isFinite(raw)) return DEFAULT_MAX_ITERATIONS;
	return Math.max(1, Math.min(HARD_MAX_ITERATIONS, Math.floor(raw)));
}

/**
 * The shared brain. Called at a turn boundary (the agent just finished a turn):
 * decide whether it should take another, and if so with what prompt.
 *
 * Order matters — safety and completion are checked BEFORE continuation:
 *   1. A blank prompt can never drive a useful turn → stop.
 *   2. Iteration cap reached → stop (the backstop; see DEFAULT_MAX_ITERATIONS).
 *   3. Goal sentinel present in the last output → stop (agent declared done).
 *   4. Otherwise → continue with the configured prompt.
 *
 * `lastOutput` is the text the agent produced on the turn that just ended, used
 * only for the goal check. Bindings that can't cheaply capture it (or loops with
 * no `stopSignal`) pass undefined; the cap still bounds the loop.
 */
export function decideContinuation(
	config: AgentLoopConfig,
	state: AgentLoopState,
	lastOutput?: string,
): LoopDecision {
	const prompt = config.prompt?.trim() ?? "";
	if (!prompt) {
		return { continue: false, reason: stopReasonMessage("empty_prompt") };
	}

	const max = resolveMaxIterations(config);
	if (state.iterations >= max) {
		return { continue: false, reason: stopReasonMessage("max_iterations", max) };
	}

	if (config.stopSignal && lastOutput?.includes(config.stopSignal)) {
		return {
			continue: false,
			reason: stopReasonMessage("goal_reached", undefined, config.stopSignal),
		};
	}

	return {
		continue: true,
		prompt,
		reason: `turn ${state.iterations + 1}/${max}`,
	};
}

/**
 * Compose the natural-language loop instruction from a config — the body a
 * self-pacing binding hands to the agent (Claude's `/loop` prepends its own
 * `/loop ` verb; a plain-prompt fallback uses this as-is). Bakes the two
 * termination conditions the shared brain enforces into words the agent can act
 * on itself: the turn cap (always) and the stop signal (when configured). This
 * is the Claude counterpart to `decideContinuation` — for `/loop` the agent owns
 * the per-turn decision, so the config has to travel as instruction, not code.
 */
export function composeLoopInstruction(config: AgentLoopConfig): string {
	const prompt = config.prompt?.trim() ?? "";
	const max = resolveMaxIterations(config);
	const parts = [prompt, `Keep going until the task is complete, then stop.`];
	if (config.stopSignal) {
		parts.push(`When it is complete, output exactly "${config.stopSignal}" and stop.`);
	}
	parts.push(`Do not run more than ${max} turns; stop and report if you reach that limit.`);
	return parts.filter(Boolean).join(" ");
}

function stopReasonMessage(reason: StopReason, max?: number, signal?: string): string {
	switch (reason) {
		case "goal_reached":
			return `loop finished — agent emitted its stop signal${signal ? ` (${signal})` : ""}`;
		case "max_iterations":
			return `loop finished — reached the ${max}-turn cap`;
		case "empty_prompt":
			return "loop stopped — no prompt configured";
	}
}
