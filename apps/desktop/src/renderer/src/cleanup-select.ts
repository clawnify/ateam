// Where the cleanup dialog's selection lands when rows leave its list (deleted,
// kept, or no longer matching the filter): the next row down, as the list is
// shown. Working down the list is then one click per row, Delete, Delete, ...,
// instead of re-selecting between each. Pure + unit-tested.

/**
 * The row to select once every id in `leaving` is gone, starting from `from`:
 * the first row below it that stays, else the nearest one above. Null when no
 * row stays. A `from` that is not in `shown` lands on the first row that stays.
 */
export function landingAfter(
	shown: readonly string[],
	from: string,
	leaving: ReadonlySet<string>,
): string | null {
	const at = shown.indexOf(from);
	const stays = (id: string) => !leaving.has(id);
	return (
		shown.slice(at + 1).find(stays) ?? shown.slice(0, Math.max(at, 0)).reverse().find(stays) ?? null
	);
}
