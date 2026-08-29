// Multi-engine aggregation — the core of "per-task environment" (see the Cursor
// study + the connectivity decision doc). Instead of the global switch in host.ts
// (one `active` backend, others disposed), the desktop can hold SEVERAL backends at
// once — the local Mac engine plus any connected boxes — and present ONE board that
// unions their tasks, each task's "environment" being simply the backend that owns it.
//
// There is no shared task store to add an `environment` column to: every engine is
// sovereign over its own SQLite (see @ateam/server engine.ts). So aggregation is a
// CLIENT concern, and it reduces to routing each RPC to the right engine + merging
// the collection reads. Because every id (project/task/terminal) is a globally-unique
// randomUUID (packages/db schema.ts), a flat `id → backend` registry routes safely —
// no per-engine id namespacing needed.
//
// This module is pure (no Electron) and, for now, UNWIRED — host.ts keeps its
// single-active path until this is proven and flag-gated in. It is the load-bearing
// slice: hold N backends, route every call correctly, merge the board.
import { CH } from "@ateam/protocol";
import type { Backend } from "./backend";
import { withTimeout } from "./timeout";

/** Collection reads with no entity key — merge the results across every backend. */
const MERGE = new Set<string>([CH.projectsList, CH.agentsList, CH.loopsList]);

// A merge read is a SQLite select on every engine, so slowness here means the WIRE, not
// the work: a box that's asleep, half-open, or wedged. The union must degrade to the
// engines that answered — "the rest of the board never waits for it" — and NOT take the
// whole board down with the one dead engine, which a bare Promise.all did twice over: it
// hung forever on a stale backend (an RPC has no per-call timeout), and rejected the
// entire list if one engine errored. Applies to merge reads only; entity calls still
// wait as long as their work takes (a clone, a merge, an installer).
const MERGE_TIMEOUT_MS = 10_000;

/** Entity-scoped calls — route to the backend that owns the id in the args. */
const ENTITY = new Set<string>([
	CH.tasksList, // projectId
	CH.tasksCreate, // {projectId}
	CH.tasksRemove,
	CH.tasksSetColumn,
	CH.tasksCleanup,
	CH.tasksCleanupPreview,
	CH.tasksCleanupCandidates,
	CH.projectsRemove,
	CH.projectsRemoteUrl, // projectId — a box's project has a box's remote
	CH.gitCommit,
	CH.gitPush,
	CH.gitUpdate,
	CH.gitMerge,
	CH.gitDiff,
	CH.gitFileDiff,
	CH.gitStatus,
	CH.ptySpawnAgent, // {taskId}
	CH.ptySpawnShell, // {taskId}
	// Loops live on the engine that runs them — that's what makes a loop local
	// or remote. Create routes by the target project's engine; the rest by the
	// loop id learned from the merged loopsList.
	CH.loopsCreate, // {projectId}
	CH.loopsSetEnabled, // loop id
	CH.loopsRunNow, // loop id
	CH.loopsUpdate, // {id}
	CH.loopsDelete, // loop id
	CH.searchSessions, // {projectId} — a box searches the history on its own disk
	CH.ptyListForTask, // taskId
	CH.ptyWrite, // terminalId
	CH.ptyResize,
	CH.ptyKill,
	CH.ptySnapshot,
]);

/** Pull the owning-entity id out of a call's args (string arg, or an id-ish field). */
export function candidateId(args: unknown[]): string | undefined {
	const a = args[0];
	if (typeof a === "string") return a;
	if (a && typeof a === "object") {
		const o = a as Record<string, unknown>;
		for (const k of ["taskId", "projectId", "terminalId", "id"]) {
			if (typeof o[k] === "string") return o[k] as string;
		}
	}
	return undefined;
}

/** Register every id a result carries (project/task `id`, session `terminalId`) as
 *  owned by the backend that produced it, so later calls route back to it. */
function learn(reg: Map<string, Backend>, backend: Backend, result: unknown): void {
	const add = (v: unknown): void => {
		if (v && typeof v === "object") {
			const o = v as Record<string, unknown>;
			for (const k of ["id", "terminalId"]) {
				if (typeof o[k] === "string") reg.set(o[k] as string, backend);
			}
		}
	};
	if (Array.isArray(result)) for (const item of result) add(item);
	else add(result);
}

/** Merge collection results from several backends; dedupe by `id` (agents overlap). */
function merge(results: unknown[]): unknown[] {
	const out: unknown[] = [];
	const seen = new Set<string>();
	for (const r of results) {
		if (!Array.isArray(r)) continue;
		for (const item of r) {
			const id =
				item && typeof item === "object" ? (item as Record<string, unknown>).id : undefined;
			if (typeof id === "string") {
				if (seen.has(id)) continue;
				seen.add(id);
			}
			out.push(item);
		}
	}
	return out;
}

export interface Aggregate {
	/** Route/merge one request across the held backends (drop-in for Router.handle). */
	handle(method: string, args: unknown[]): Promise<unknown>;
	/** Invoke a method ON the engine that owns `ownerId` (fallback when unknown) —
	 *  for calls whose own args carry no routable id (e.g. util:writeImageBytes
	 *  must land on the engine whose agent will read the file). */
	handleFor(ownerId: string, method: string, args: unknown[]): Promise<unknown>;
	/** Whether `ownerId` lives on a box or the local engine ("local" when unknown). */
	ownerKindOf(ownerId: string): "local" | "remote";
	/** The learned id→backend map (which environment owns each entity). Read-only use. */
	readonly ownerOf: ReadonlyMap<string, Backend>;
}

/**
 * Build an aggregate over `backends`, resolving un-routable calls (register, fs,
 * writeImageBytes, handshake) to `fallback` — the local engine by convention.
 * `backends` should include `fallback`.
 */
export function createAggregate(
	backends: readonly Backend[],
	fallback: Backend,
	opts: { mergeTimeoutMs?: number } = {},
): Aggregate {
	const reg = new Map<string, Backend>();
	const mergeTimeoutMs = opts.mergeTimeoutMs ?? MERGE_TIMEOUT_MS;

	async function handle(method: string, args: unknown[]): Promise<unknown> {
		if (MERGE.has(method)) {
			const results = await Promise.all(
				backends.map(async (b) => {
					try {
						// Promise.resolve: a backend may answer synchronously (the local engine's
						// in-process handler), and only a real promise can be raced against a timer.
						const r = await withTimeout(
							Promise.resolve(b.handle(method, args)),
							mergeTimeoutMs,
							method,
						);
						learn(reg, b, r);
						return r;
					} catch {
						// This engine contributes nothing to the union this time. Its ids stay
						// learned, so a task already on the board keeps routing to it; the
						// connection layer is what decides it's gone (host.ts).
						return [];
					}
				}),
			);
			return merge(results);
		}

		let backend = fallback;
		if (ENTITY.has(method)) {
			const id = candidateId(args);
			backend = (id && reg.get(id)) || fallback;
		}
		const result = await backend.handle(method, args);
		learn(reg, backend, result);
		return result;
	}

	async function handleFor(ownerId: string, method: string, args: unknown[]): Promise<unknown> {
		return (reg.get(ownerId) ?? fallback).handle(method, args);
	}

	return {
		handle,
		handleFor,
		ownerKindOf: (ownerId) => (reg.get(ownerId) ?? fallback).kind,
		ownerOf: reg,
	};
}
