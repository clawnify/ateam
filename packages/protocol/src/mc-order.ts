import type { TaskDTO } from "./index";
import { byLatestActivity } from "./recency";

/** Absolute slots across pages, remembered separately for each grid. */
export type McPins = Record<string, number>;

type McTask = Pick<TaskDTO, "id" | "column" | "agentStatus" | "lastEventAt">;

/** Needs You first, then newest activity within each band. */
export function byMcPriority(a: McTask, b: McTask): number {
	const needsYou = (t: McTask) =>
		t.column === "needs_attention" || t.agentStatus === "awaiting_input";
	return Number(needsYou(b)) - Number(needsYou(a)) || byLatestActivity(a, b);
}

/** Fill the free slots by priority without changing the grid's shape. */
export function orderMcTiles<T extends { task: McTask }>(
	tiles: T[],
	pins: McPins,
	priority?: ReadonlyMap<string, number>,
): T[] {
	const pinned = tiles
		.flatMap((tile) => {
			const slot = pins[tile.task.id];
			return slot === undefined ? [] : [{ tile, slot }];
		})
		.sort((a, b) => a.slot - b.slot);
	const free = tiles
		.filter((t) => pins[t.task.id] === undefined)
		.sort((a, b) =>
			priority
				? (priority.get(a.task.id) ?? Number.MAX_SAFE_INTEGER) -
					(priority.get(b.task.id) ?? Number.MAX_SAFE_INTEGER)
				: byMcPriority(a.task, b.task),
		);
	const slots = new Map<number, T>();
	let previous = -1;
	for (const [i, pin] of pinned.entries()) {
		// When the grid shrinks, retain every tile once, with pins as close to
		// their requested slots as possible. Their saved slots survive regrowth.
		const slot = Math.max(previous + 1, Math.min(pin.slot, free.length + i));
		slots.set(slot, pin.tile);
		previous = slot;
	}
	let next = 0;
	const result: T[] = [];
	for (let i = 0; i < tiles.length; i++) {
		const tile = slots.get(i) ?? free[next++];
		if (tile) result.push(tile);
	}
	return result;
}

/** Keep shared tiles in their slots; only page entrants replace page leavers. */
export function stabilizeMcPages(next: string[], current: string[], pageSize: number): string[] {
	if (next.length !== current.length) return next;
	const stable: string[] = [];
	for (let start = 0; start < next.length; start += pageSize) {
		const before = current.slice(start, start + pageSize);
		const after = next.slice(start, start + pageSize);
		const wasHere = new Set(before);
		const staysHere = new Set(after);
		const incoming = after.filter((id) => !wasHere.has(id));
		let arrival = 0;
		for (const id of before) {
			const replacement = staysHere.has(id) ? id : incoming[arrival++];
			if (replacement !== undefined) stable.push(replacement);
		}
	}
	return stable;
}

/** Pin the dragged tile; a pinned destination trades slots with it. */
export function pinMcSwap(pins: McPins, ids: string[], from: string, onto: string): McPins {
	const a = ids.indexOf(from);
	const b = ids.indexOf(onto);
	if (a < 0 || b < 0 || a === b) return pins;
	return { ...pins, [from]: b, ...(pins[onto] === undefined ? {} : { [onto]: a }) };
}

/** A task pill with no live tile reserves its destination while waking. */
export function pinMcArrival(pins: McPins, ids: string[], id: string, onto: string | null): McPins {
	const target = onto === null ? -1 : ids.indexOf(onto);
	const slot = target < 0 ? ids.length : target;
	const updated = { ...pins, [id]: slot };
	if (onto && pins[onto] !== undefined) {
		const occupied = new Set(
			Object.entries(updated)
				.filter(([key]) => key !== onto)
				.map(([, at]) => at),
		);
		let at = slot + 1;
		while (occupied.has(at)) at++;
		updated[onto] = at;
	}
	return updated;
}

/** Roll back a failed wake's placement, retaining subsequent manual changes. */
export function undoMcPins(current: McPins, before: McPins, after: McPins): McPins {
	const next = { ...current };
	for (const [id, slot] of Object.entries(after)) {
		if (slot === before[id] || next[id] !== slot) continue;
		const original = before[id];
		if (original === undefined) delete next[id];
		else next[id] = original;
	}
	return next;
}
