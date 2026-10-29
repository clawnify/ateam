// A box the app isn't holding still has a board: the one it showed last.
//
// A box's tasks exist for the aggregate only while its engine is held, so a box
// that slept (idle sleep is the normal state of a box now) or dropped off the
// network took every one of its cards with it, and the only way back was to start
// a new task on it. Its board as last seen is kept on this Mac instead (the
// `hosts.snapshot` column), and an OFFLINE backend serves it: the aggregate
// merges and routes it like any engine, so the cards keep their place, their
// project and their origin, with no second path through the board.
//
// The snapshot is exact when it matters most: a paused box can't change. What it
// can't do is act, so every call that would reach the engine is refused, except
// the reads the board makes for any visible task, which answer empty.
import { CH } from "@ateam/protocol";
import type { Backend } from "./backend";

export interface BoxSnapshot {
	/** When it was taken. */
	at: number;
	projects: { id: string }[];
	/** projectId → that project's tasks. */
	tasks: Record<string, unknown[]>;
	loops: unknown[];
}

/** A stored snapshot, or null for anything that isn't one (none yet, a bad row). */
export function asSnapshot(value: unknown): BoxSnapshot | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Partial<BoxSnapshot>;
	if (typeof v.at !== "number" || !Array.isArray(v.projects) || !Array.isArray(v.loops)) {
		return null;
	}
	if (!v.tasks || typeof v.tasks !== "object") return null;
	return v as BoxSnapshot;
}

/** Read a held box's board, the same three reads the renderer makes. */
export async function takeSnapshot(backend: Backend): Promise<BoxSnapshot> {
	const projects = (await backend.handle(CH.projectsList, [])) as { id: string }[];
	const tasks: Record<string, unknown[]> = {};
	await Promise.all(
		projects.map(async (p) => {
			tasks[p.id] = (await backend.handle(CH.tasksList, [p.id])) as unknown[];
		}),
	);
	const loops = (await backend.handle(CH.loopsList, [])) as unknown[];
	return { at: Date.now(), projects, tasks, loops };
}

// Reads the board makes for every task it shows, not only the open one (Mission
// Control lists each task's sessions in one Promise.all). Refusing them would
// take the whole grid down for one sleeping box; a box nobody holds has no live
// session to list, so empty is the true answer.
const EMPTY_READS = new Set<string>([
	CH.agentsList,
	CH.ptyListForTask,
	CH.ptyListRestorable,
	CH.searchSessions,
]);

/** The marker in the refusal, so a caller can tell "wake it first" from a real failure. */
export const OFFLINE_ERROR = "isn't connected";

/** Serve a box's last-seen board while it isn't held. `label` names it in refusals. */
export function offlineBackend(snapshot: BoxSnapshot, label: string): Backend {
	return {
		kind: "remote",
		methods: [],
		handle(method, args) {
			if (method === CH.projectsList) return snapshot.projects;
			if (method === CH.loopsList) return snapshot.loops;
			if (method === CH.tasksList) return snapshot.tasks[String(args[0])] ?? [];
			if (EMPTY_READS.has(method)) return [];
			return Promise.reject(
				new Error(
					`"${label}" ${OFFLINE_ERROR}: it is asleep or out of reach. Open one of its tasks to wake it.`,
				),
			);
		},
		on: () => () => {},
		dispose: () => {},
	};
}

// A box that left without being asked is tried again: soon at first (a blip, or
// the Mac's network coming back after sleep), then at a steady pace. The cap
// bounds what an unreachable box costs (one connect attempt per interval) and how
// late a box woken elsewhere (the phone, a loop) shows up live here. Its cards
// stay on the board in between, so the cap is about freshness, not visibility.
export const RECONNECT_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

/** How long to wait before reconnect attempt `attempt` (0-based). */
export function reconnectDelay(attempt: number): number {
	return RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 120_000;
}
