// The project switcher's order: the projects switched to most recently first.
// Switching between the top three leaves them where they are, so the ones in
// use stay put under the cursor; a project from further down moves to the top.
// Kept on this Mac in localStorage, with the window's other state: it is usage,
// not a choice, so it stays out of settings.json.
//
// Pure + unit-tested (see project-order.test.ts); only readProjectOrder and
// saveProjectOrder touch storage.

const KEY = "ateam.projectOrder";

/** How many projects at the top keep their places when switched between. */
const STEADY = 3;

/** The remembered card keys (`UnifiedProject.key`), most recent first. */
export function readProjectOrder(): string[] {
	try {
		const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
		return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
	} catch {
		return [];
	}
}

export function saveProjectOrder(order: string[]) {
	try {
		localStorage.setItem(KEY, JSON.stringify(order));
	} catch {
		// Storage full or off: the menu keeps this session's order only.
	}
}

/** The cards in the switcher's order: the remembered ones as remembered, then
 *  any never switched to, in the board's own order. */
export function orderProjects<T extends { key: string }>(cards: T[], order: string[]): T[] {
	const rank = new Map(order.map((k, i) => [k, i]));
	return cards
		.map((card, i) => ({ card, r: rank.get(card.key) ?? order.length + i }))
		.sort((a, b) => a.r - b.r)
		.map((x) => x.card);
}

/**
 * The order once `key` is switched to. `keys` are the cards on the board now, in
 * the board's own order. Unchanged (the same array) when the card is already one
 * of the top three shown; otherwise it moves to the top and the rest shift down.
 * Remembered cards not on the board (a box that is away) go after the rest
 * rather than being forgotten.
 */
export function bumpProject(order: string[], keys: string[], key: string): string[] {
	const shown = orderProjects(
		keys.map((k) => ({ key: k })),
		order,
	).map((c) => c.key);
	const at = shown.indexOf(key);
	if (at === -1 || at < STEADY) return order;
	const onBoard = new Set(shown);
	return [key, ...shown.filter((k) => k !== key), ...order.filter((k) => !onBoard.has(k))];
}
