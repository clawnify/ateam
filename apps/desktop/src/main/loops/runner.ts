import type { AteamDb, Loop } from "@ateam/db";
import { repo } from "@ateam/db";
import type { LoopDTO } from "../../shared/types";
import type { LoopContext, LoopDefinition, LoopOutcome } from "./types";

interface Instance {
	def: LoopDefinition;
	loopId: string;
	scopeKey?: string;
	timer: ReturnType<typeof setTimeout> | null;
	running: boolean;
}

export interface LoopRunnerDeps {
	db: AteamDb;
	onTaskUpdated: (taskId: string) => void;
	log?: (line: string) => void;
}

/**
 * Schedules and runs registered Loops. Definitions live in code; this owns
 * their lifecycle: instantiate (global loops on start, per-task loops via
 * `syncPerTask`), schedule with fixed or self-paced cadence, persist last-run
 * telemetry to the `loops` table, and never overlap a loop with itself. The UI
 * drives it through `list` / `setEnabled` / `runNow`.
 */
export class LoopRunner {
	private readonly defs = new Map<string, LoopDefinition>();
	private readonly instances = new Map<string, Instance>();
	private started = false;

	constructor(private readonly deps: LoopRunnerDeps) {}

	register(def: LoopDefinition): void {
		this.defs.set(def.id, def);
	}

	private instanceId(def: LoopDefinition, scopeKey?: string): string {
		return def.scope === "global" ? def.id : `${def.id}:${scopeKey}`;
	}

	/** Instantiate global loops and schedule their first runs. */
	start(): void {
		if (this.started) return;
		this.started = true;
		for (const def of this.defs.values()) {
			if (def.scope === "global") this.ensureInstance(def);
		}
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
		if (row.enabled) this.schedule(inst, this.initialDelay(def));
		return inst;
	}

	removeInstance(loopId: string, opts: { deleteRow?: boolean } = {}): void {
		const inst = this.instances.get(loopId);
		if (inst?.timer) clearTimeout(inst.timer);
		this.instances.delete(loopId);
		if (opts.deleteRow) repo.deleteLoop(this.deps.db, loopId);
	}

	/**
	 * Reconcile per-task instances of a definition to the given active task ids —
	 * spin up loops for new tasks, tear down loops for tasks that are gone.
	 */
	syncPerTask(defId: string, activeTaskIds: string[]): void {
		const def = this.defs.get(defId);
		if (!def || def.scope !== "per_task") return;
		const wanted = new Set(activeTaskIds);
		for (const taskId of wanted) this.ensureInstance(def, taskId);
		for (const inst of [...this.instances.values()]) {
			if (inst.def.id === defId && inst.scopeKey && !wanted.has(inst.scopeKey)) {
				this.removeInstance(inst.loopId, { deleteRow: true });
			}
		}
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
			return {
				id: row.id,
				definitionId: row.definitionId,
				title: def?.title ?? row.definitionId,
				description: def?.description ?? "",
				scope: def?.scope ?? "global",
				scopeKey: row.scopeKey ?? null,
				enabled: row.enabled,
				cadence: def?.cadence.mode ?? "self_paced",
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
	private initialDelay(def: LoopDefinition): number {
		// Honor a fixed interval as-is; for self-paced loops do a first pass soon
		// after boot so a stale board is corrected promptly.
		if (def.cadence.mode === "fixed") return def.cadence.everyMs;
		return Math.min(2000, def.cadence.minMs);
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
			scopeKey: inst.scopeKey,
			onTaskUpdated: this.deps.onTaskUpdated,
			log: (m) => this.deps.log?.(`[loop ${inst.loopId}] ${m}`),
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
		repo.updateLoop(this.deps.db, inst.loopId, {
			lastRunAt: Date.now(),
			lastStatus: status,
			lastSummary: outcome.summary ?? null,
			lastError: error,
			runs: (row.runs ?? 0) + 1,
		});
		if (status === "done") {
			this.removeInstance(inst.loopId, { deleteRow: true });
			return;
		}
		// Re-check liveness/enabled — the run may have disabled or removed us.
		if (!this.instances.has(inst.loopId)) return;
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
