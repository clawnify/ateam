// ---- mission control layout ----
// How agent tiles are arranged: "grid" is a 2x2 overview (tiles half the
// window wide and tall), "main" gives the first tile the full-height left half
// and stacks the next two in the right half, "split" lays them side-by-side at
// full window height, "stack" stacks them full-width, "grid3x2" is three
// columns by two rows. Extra tiles go to further pages, flipped via the
// bottom-right pager or Ctrl/Cmd+Up/Down.
export type McLayout = "grid" | "grid3x2" | "main" | "split" | "stack";
// What a project's layout is set to: one of the layouts, or "auto", which picks
// the one that fits the live tiles, and refits as tiles arrive and leave.
export type McChoice = McLayout | "auto";

// Tiles per page: how many terminals each layout actually shows at once.
export const MC_PAGE_SIZE: Record<McLayout, number> = {
	grid: 4,
	grid3x2: 6,
	main: 3,
	split: 2,
	stack: 1,
};

// Auto's pick: the smallest layout whose page holds every tile, so none is left
// on a second page and no slot sits empty that a smaller layout would fill.
// Past six, the 3x2 (the most a page holds), with pages for the rest.
export function bestMcLayout(tiles: number): McLayout {
	const bySize = (Object.keys(MC_PAGE_SIZE) as McLayout[]).sort(
		(a, b) => MC_PAGE_SIZE[a] - MC_PAGE_SIZE[b],
	);
	return bySize.find((l) => MC_PAGE_SIZE[l] >= tiles) ?? "grid3x2";
}
