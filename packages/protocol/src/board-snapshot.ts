// A box the client isn't holding still has a board: the one it showed last.
//
// A box's tasks exist for an aggregate (aggregate.ts) only while its engine is
// held, so a box that slept (idle sleep is the normal state of a box now) or
// dropped off the network took every one of its cards with it, and the only way
// back was to start a new task on it. Its board as last seen is kept by the client
// instead (the desktop in its `hosts.snapshot` column, the phone in AsyncStorage),
// and served in the engine's place: the aggregate merges and routes it like any
// engine, so the cards keep their place, their project and their origin, with no
// second path through the board.
//
// The snapshot is exact when it matters most: a paused box can't change. What it
// can't do is act, so every call that would reach the engine is refused, except
// the reads the board makes for any visible task, which answer empty.
import { CH } from "./channels";

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

/** Read a held box's board, the same three reads the board makes. */
export async function takeSnapshot(engine: {
	handle(method: string, args: unknown[]): unknown;
}): Promise<BoxSnapshot> {
	const projects = (await engine.handle(CH.projectsList, [])) as { id: string }[];
	const tasks: Record<string, unknown[]> = {};
	await Promise.all(
		projects.map(async (p) => {
			tasks[p.id] = (await engine.handle(CH.tasksList, [p.id])) as unknown[];
		}),
	);
	const loops = (await engine.handle(CH.loopsList, [])) as unknown[];
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
	CH.skillsList,
]);

/** The marker in the refusal, so a caller can tell "wake it first" from a real failure. */
export const OFFLINE_ERROR = "isn't connected";

/** Answer one call from a box's last-seen board. `label` names the box in refusals. */
export function offlineHandle(
	snapshot: BoxSnapshot,
	label: string,
): (method: string, args: unknown[]) => unknown {
	return (method, args) => {
		if (method === CH.projectsList) return snapshot.projects;
		if (method === CH.loopsList) return snapshot.loops;
		if (method === CH.tasksList) return snapshot.tasks[String(args[0])] ?? [];
		if (EMPTY_READS.has(method)) return [];
		return Promise.reject(
			new Error(
				`"${label}" ${OFFLINE_ERROR}: it is asleep or out of reach. Open one of its tasks to wake it.`,
			),
		);
	};
}
