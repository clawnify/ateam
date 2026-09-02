import { randomUUID } from "node:crypto";
import type { AteamDb, Loop, LoopCadenceMode } from "@ateam/db";
import { repo } from "@ateam/db";
import type { LoopDTO } from "@ateam/protocol";
import { getTemplate } from "./templates";
import type {
	LoopCadence,
	LoopContext,
	LoopDefinition,
	LoopOutcome,
	LoopSessionOps,
} from "./types";

/**
 * How long after start an already-overdue loop waits before its catch-up run.
 * Long enough for the app to finish booting (window, PTY daemon, box
 * connections), short enough that a missed tick still feels prompt.
 */
const SETTLE_MS = 60_000;

interface Instance {
	def: LoopDefinition;
	loopId: string;
	scopeKey?: string;
	timer: ReturnType<typeof setTimeout> | null;
	running: boolean;
}

export interface LoopRunnerDeps {
	db: AteamDb;
	log?: (line: string) => void;
	/** Task/session capabilities handed through to each run (engine-wired). */
	sessions: LoopSessionOps;
}

export interface CreateUserLoopInput {
	templateId: string;
	name: string;
	projectId?: string;
	config?: Record<string, unknown>;
	cadenceMode?: LoopCadenceMode;
	intervalMs?: number;
	enabled?: boolean;
}

/**
 * Schedules and runs Loops. Loops are user-created only — nothing registers a
 * loop on the user's behalf; each one is a template instance (today: a
 * scheduled agent session) persisted in the `loops` table. This owns their
 * lifecycle: rebuild from rows on start, schedule with fixed or self-paced
 * cadence, persist last-run telemetry, and never overlap a loop with itself.
 * The UI drives it through `list` / `setEnabled` / `runNow`.
 */
export class LoopRunner {
	private readonly defs = new Map<string, LoopDefinition>();
	private readonly instances = new Map<string, Instance>();
	private started = false;

	constructor(private readonly deps: LoopRunnerDeps) {}

	/**
	 * Register a code-defined loop. NOTHING in the app calls this anymore —
	 * loops are user-created only (see start()). Kept as the seam for tests and
	 * for any future code loop, which must be a deliberate user opt-in.
	 */
	register(def: LoopDefinition): void {
		this.defs.set(def.id, def);
	}

	private instanceId(def: LoopDefinition, scopeKey?: string): string {
		return def.scope === "global" ? def.id : `${def.id}:${scopeKey}`;
	}

	/** Rebuild persisted user loops and schedule their first runs. */
	start(): void {
		if (this.started) return;
		this.started = true;
		for (const row of repo.listLoops(this.deps.db)) {
			if (row.kind !== "user") {
				// Builtin reconciler rows from earlier versions (board-reconciler
				// etc.) — nothing registers those anymore; drop the stale row unless
				// a def was registered for it (the test seam).
				if (!this.defs.has(row.definitionId)) repo.deleteLoop(this.deps.db, row.id);
				continue;
			}
			if (this.defs.has(row.id)) continue;
			const def = this.defFromUserRow(row);
			// A user row whose template left the catalog can never run again —
			// prune it rather than list a ghost the UI can't do anything with.
			if (def) this.defs.set(def.id, def);
			else repo.deleteLoop(this.deps.db, row.id);
		}
		for (const def of this.defs.values()) {
			if (def.scope === "global") this.ensureInstance(def);
		}
	}

	/** Build a runnable definition from a persisted user-loop row + its template. */
	private defFromUserRow(row: Loop): LoopDefinition | null {
		if (!row.templateId) return null;
		const template = getTemplate(row.templateId);
		if (!template) return null;
		const config = {
			...(row.config ?? {}),
			projectId: row.projectId ?? undefined,
			// Its own row id, so a run can read/update its record (run count,
			// lastTaskId) — see the agent-session template.
			loopId: row.id,
		};
		const cadence: LoopCadence =
			row.cadenceMode === "fixed" && row.intervalMs
				? { mode: "fixed", everyMs: row.intervalMs }
				: template.defaultCadence;
		return {
			id: row.id,
			title: row.name ?? template.title,
			description: template.description,
			scope: "global",
			cadence,
			run: template.build(config),
		};
	}

	/** Create a user loop from a template, persist it, and start it. */
	createUserLoop(input: CreateUserLoopInput): LoopDTO[] {
		const template = getTemplate(input.templateId);
		if (!template) throw new Error(`Unknown loop template: ${input.templateId}`);
		const id = randomUUID();
		repo.ensureLoop(this.deps.db, {
			id,
			definitionId: id,
			scopeKey: null,
			kind: "user",
			templateId: input.templateId,
			name: input.name,
			projectId: input.projectId ?? null,
			config: input.config ?? {},
			cadenceMode: input.cadenceMode ?? null,
			intervalMs: input.intervalMs ?? null,
			enabled: input.enabled ?? true,
		});
		const row = repo.getLoop(this.deps.db, id);
		const def = row && this.defFromUserRow(row);
		if (def) {
			this.defs.set(def.id, def);
			this.ensureInstance(def);
		}
		return this.describe();
	}

	/**
	 * Edit a user loop in place: patch its row (config is merged over the stored
	 * config so runtime keys like lastTaskId survive), rebuild the definition,
	 * and reschedule from now with the new interval. Project/template are fixed
	 * at creation — changing environment is delete + recreate.
	 */
	updateUserLoop(input: {
		id: string;
		name?: string;
		intervalMs?: number;
		config?: Record<string, unknown>;
	}): LoopDTO[] {
		const row = repo.getLoop(this.deps.db, input.id);
		if (!row || row.kind !== "user") throw new Error(`Loop not found: ${input.id}`);
		repo.updateLoop(this.deps.db, input.id, {
			name: input.name ?? row.name,
			intervalMs: input.intervalMs ?? row.intervalMs,
			cadenceMode: "fixed",
			config: { ...row.config, ...(input.config ?? {}) },
		});
		const updated = repo.getLoop(this.deps.db, input.id);
		const def = updated && this.defFromUserRow(updated);
		if (def) {
			this.defs.set(def.id, def);
			// Swap the running instance for one built on the new definition; keep
			// the row, so ensureInstance reschedules it (if enabled) against the
			// persisted schedule under the NEW interval — shortening the interval
			// on a loop that is already overdue by it runs it shortly, rather
			// than waiting out a fresh full interval.
			this.removeInstance(input.id);
			this.ensureInstance(def);
		}
		return this.describe();
	}

	/** Delete a user loop (instance, timer, and persisted row). */
	deleteUserLoop(id: string): LoopDTO[] {
		this.removeInstance(id, { deleteRow: true });
		this.defs.delete(id);
		return this.describe();
	}

	/** Cancel all timers (e.g. on app quit). */
	stop(): void {
		this.started = false;
		for (const inst of this.instances.values()) {
			if (inst.timer) clearTimeout(inst.timer);
			inst.timer = null;
		}
		this.instances.clear();
	}

	/** Create (or return) an instance, scheduling it if enabled. */
	ensureInstance(def: LoopDefinition, scopeKey?: string): Instance {
		const loopId = this.instanceId(def, scopeKey);
		const existing = this.instances.get(loopId);
		if (existing) return existing;
		const row = repo.ensureLoop(this.deps.db, {
			id: loopId,
			definitionId: def.id,
			scopeKey: scopeKey ?? null,
			enabled: def.enabledByDefault ?? true,
		});
		const inst: Instance = { def, loopId, scopeKey, timer: null, running: false };
		this.instances.set(loopId, inst);
		if (row.enabled) this.schedule(inst, this.initialDelay(def, row));
		return inst;
	}

	removeInstance(loopId: string, opts: { deleteRow?: boolean } = {}): void {
		const inst = this.instances.get(loopId);
		if (inst?.timer) clearTimeout(inst.timer);
		this.instances.delete(loopId);
		if (opts.deleteRow) repo.deleteLoop(this.deps.db, loopId);
	}

	setEnabled(loopId: string, enabled: boolean): void {
		repo.updateLoop(this.deps.db, loopId, {
			enabled,
			nextRunAt: enabled ? undefined : null,
		});
		const inst = this.instances.get(loopId);
		if (!inst) return;
		if (enabled) {
			if (!inst.timer && !inst.running) {
				this.schedule(inst, this.initialDelay(inst.def));
			}
		} else if (inst.timer) {
			clearTimeout(inst.timer);
			inst.timer = null;
		}
	}

	/** Run an instance now, even if disabled (manual trigger from the UI). */
	async runNow(loopId: string): Promise<void> {
		const inst = this.instances.get(loopId);
		if (!inst) return;
		if (inst.timer) {
			clearTimeout(inst.timer);
			inst.timer = null;
		}
		await this.fire(inst, true);
	}

	list(): Loop[] {
		return repo.listLoops(this.deps.db);
	}

	/** Combined view for the UI: persisted telemetry + code-side definition meta. */
	describe(): LoopDTO[] {
		return this.list().map((row) => {
			const def = this.defs.get(row.definitionId);
			const cadence = def?.cadence;
			return {
				id: row.id,
				definitionId: row.definitionId,
				title: def?.title ?? row.name ?? row.definitionId,
				description: def?.description ?? "",
				scope: def?.scope ?? "global",
				scopeKey: row.scopeKey ?? null,
				kind: row.kind,
				templateId: row.templateId ?? null,
				projectId: row.projectId ?? null,
				enabled: row.enabled,
				cadence: cadence?.mode ?? "self_paced",
				prompt: typeof row.config?.prompt === "string" ? row.config.prompt : null,
				agentId: typeof row.config?.agentId === "string" ? row.config.agentId : null,
				followUp: typeof row.config?.followUp === "string" ? row.config.followUp : null,
				// The loop's persistent task (lastTaskId = pre-persistent-era key).
				taskId:
					typeof row.config?.taskId === "string"
						? row.config.taskId
						: typeof row.config?.lastTaskId === "string"
							? row.config.lastTaskId
							: null,
				intervalMs: row.intervalMs ?? (cadence?.mode === "fixed" ? cadence.everyMs : null),
				lastRunAt: row.lastRunAt ?? null,
				nextRunAt: row.nextRunAt ?? null,
				lastStatus: row.lastStatus ?? null,
				lastSummary: row.lastSummary ?? null,
				lastError: row.lastError ?? null,
				runs: row.runs,
			};
		});
	}

	// ---- internals ----
	/**
	 * Delay before an instance's FIRST run of this process.
	 *
	 * Timers live in the process, but the schedule lives in the row. Locally the
	 * runner is started by the desktop app (apps/desktop/src/main/index.ts), so
	 * it dies on every quit; a boot that always waited a whole interval pushed
	 * the loop further out each launch and silently dropped every tick in
	 * between, so a 1h loop on a Mac closed more often than hourly never ran at
	 * all. On a box the daemon stays up, which is why this only ever bit locally.
	 *
	 * So resume from what was persisted: due = lastRunAt + interval, falling back
	 * to the nextRunAt this loop was last scheduled for (a loop that has never
	 * run has no lastRunAt, and would otherwise drift forever). Both columns are
	 * already written by schedule()/fire() — nothing new is stored.
	 *
	 * An overdue loop runs ONCE, after a short settle, never a backlog: catching
	 * up 8 hours of closed laptop with 8 sessions in one worktree is worse than
	 * the miss. Same shape as a Kubernetes CronJob's startingDeadlineSeconds.
	 *
	 * `row` is absent only for a caller that means "start the clock now" —
	 * setEnabled, where the user just flipped the loop on by hand.
	 */
	private initialDelay(def: LoopDefinition, row?: Loop): number {
		// Self-paced loops do a first pass soon after boot regardless.
		if (def.cadence.mode !== "fixed") return Math.min(2000, def.cadence.minMs);
		const everyMs = def.cadence.everyMs;
		if (!row) return everyMs;
		const due = row.lastRunAt != null ? row.lastRunAt + everyMs : (row.nextRunAt ?? null);
		if (due == null) return everyMs;
		// Don't fire into a half-booted app (the PTY daemon connects around now).
		return Math.max(SETTLE_MS, Math.min(everyMs, due - Date.now()));
	}

	private schedule(inst: Instance, delayMs: number): void {
		if (inst.timer) clearTimeout(inst.timer);
		repo.updateLoop(this.deps.db, inst.loopId, { nextRunAt: Date.now() + delayMs });
		inst.timer = setTimeout(() => {
			void this.fire(inst, false);
		}, delayMs);
	}

	private async fire(inst: Instance, force: boolean): Promise<void> {
		if (inst.running) return; // never overlap a loop with itself
		const row = repo.getLoop(this.deps.db, inst.loopId);
		if (!row) return;
		if (!row.enabled && !force) return;
		inst.running = true;
		const ctx: LoopContext = {
			db: this.deps.db,
			log: (m) => this.deps.log?.(`[loop ${inst.loopId}] ${m}`),
			...this.deps.sessions,
		};
		let outcome: LoopOutcome = {};
		let status: "ok" | "error" | "done" = "ok";
		let error: string | null = null;
		try {
			outcome = await inst.def.run(ctx);
			status = outcome.done ? "done" : "ok";
		} catch (err) {
			status = "error";
			error = err instanceof Error ? err.message : String(err);
		} finally {
			inst.running = false;
		}
		// A skipped tick started nothing, so it is not a run: leave `runs` and
		// `lastRunAt` alone. `lastRunAt` is what the next start computes the due
		// time from (initialDelay), so counting a skip would silently push the
		// schedule forward. The summary still updates, so the panel says why.
		repo.updateLoop(this.deps.db, inst.loopId, {
			lastStatus: status,
			lastSummary: outcome.summary ?? null,
			lastError: error,
			...(outcome.skipped ? {} : { lastRunAt: Date.now(), runs: (row.runs ?? 0) + 1 }),
		});
		if (status === "done") {
			this.removeInstance(inst.loopId, { deleteRow: true });
			return;
		}
		// Re-check liveness/enabled — the run may have disabled or removed us, or
		// an edit may have swapped in a REPLACEMENT instance (updateUserLoop);
		// identity, not just presence, or both instances would keep timers.
		if (this.instances.get(inst.loopId) !== inst) return;
		const after = repo.getLoop(this.deps.db, inst.loopId);
		if (!after?.enabled) return;
		this.schedule(inst, this.nextDelay(inst.def, outcome));
	}

	private nextDelay(def: LoopDefinition, outcome: LoopOutcome): number {
		if (def.cadence.mode === "fixed") return def.cadence.everyMs;
		const { minMs, maxMs } = def.cadence;
		const want = outcome.nextDelayMs ?? maxMs; // back off when unspecified
		return Math.max(minMs, Math.min(maxMs, want));
	}
}
