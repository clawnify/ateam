// ---- mission control layout ----
// How agent tiles are arranged: "grid" is a 2x2 overview (tiles half the
// window wide and tall), "main" gives the first tile the full-height left half
// and stacks the next two in the right half, "split" lays them side-by-side at
// full window height, "stack" stacks them full-width, "grid3x2" is three
// columns by two rows. Extra tiles go to further pages, flipped via the
// bottom-right pager or Ctrl/Cmd+Up/Down.
export type McLayout = "grid" | "grid3x2" | "main" | "split" | "stack";
// What a project's layout is set to: one of the layouts, or "auto", which
// shapes each page to the grid's size and the tiles on it (see bestMcShape).
export type McChoice = McLayout | "auto";

// Tiles per page: how many terminals each layout actually shows at once.
export const MC_PAGE_SIZE: Record<McLayout, number> = {
	grid: 4,
	grid3x2: 6,
	main: 3,
	split: 2,
	stack: 1,
};

// ---- Auto ----
// Auto is not one of the layouts above: it lays each page out for the space
// the grid has, in lines of tiles that fill it, so no slot sits empty. A page
// holds as many tiles as fit while the smallest terminal stays readable; the
// rest go to further pages, every page but the last full, so a tile arriving
// never moves the ones already on screen to another page.

/** The grid's size, in CSS px. */
export type McArea = { width: number; height: number };

/**
 * One page under Auto: how many tiles each line holds, first line first. With
 * flow "rows" the lines run across (a row's tiles share its width); with
 * "cols" they run down (a column's tiles share its height). Lines with fewer
 * tiles come first, so the first tiles get the bigger cells: three tiles in
 * cols [1, 2] are a full-height tile with two stacked beside it.
 */
export type McShape = { flow: "rows" | "cols"; lines: number[] };

// One terminal cell at the tiles' font (12.5px, Menlo in the app), and what a
// tile spends around its terminal: across, the 1px edges and the terminal's
// 6px padding; down, those plus the 26px bar and the 33px skills toolbar.
// Measured in the app; ratios between shapes are what matter, so a pixel off
// moves nothing.
const CELL_W = 7.53;
const CELL_H = 15;
const CHROME_W = 14;
const CHROME_H = 73;
// The terminal a tile is scored against. 30 lines rather than the classic 24:
// an agent's output scrolls down, so height is what shows more of its work.
const TARGET_COLS = 80;
const TARGET_LINES = 30;
// A page keeps adding tiles while the smallest scores at least this, about 48
// columns by 18 lines.
const FLOOR = 0.6;
// A resize moves the page size only once the space has moved this far past
// the floor, so a grid sitting at a boundary doesn't flip its pages back and
// forth as the window settles.
const MARGIN = 0.05;
// Shapes within this share of the best score tie, and the tie goes to the one
// showing the most terminal lines in all: the spare room lands as height.
const TIE = 0.05;
// The most tiles a page is ever asked to hold, a bound for the search only.
const MAX_PAGE = 36;

// How readable a tile of this size is: the lesser of its columns over 80 and
// its lines over 30. 1 is a full-size terminal; below the floor, a page is full.
function tileScore(width: number, height: number): number {
	const cols = (width - CHROME_W) / CELL_W;
	const lines = (height - CHROME_H) / CELL_H;
	return Math.min(cols / TARGET_COLS, lines / TARGET_LINES);
}

// The shape's score (its smallest tile's) and the terminal lines it shows in all.
function rate(shape: McShape, area: McArea): { score: number; lines: number } {
	const k = shape.lines.length;
	let score = Number.POSITIVE_INFINITY;
	let lines = 0;
	for (const n of shape.lines) {
		const w = shape.flow === "rows" ? area.width / n : area.width / k;
		const h = shape.flow === "rows" ? area.height / k : area.height / n;
		score = Math.min(score, tileScore(w, h));
		lines += (n * (h - CHROME_H)) / CELL_H;
	}
	return { score, lines };
}

// Every way to deal n tiles into k even lines (k = 1..n), across and down.
// Rows come first, and fewer lines first, which is the order exact ties keep.
function candidates(n: number): McShape[] {
	const out: McShape[] = [];
	for (const flow of ["rows", "cols"] as const) {
		for (let k = 1; k <= n; k++) {
			const base = Math.floor(n / k);
			const extra = n % k;
			out.push({
				flow,
				lines: [...Array(k - extra).fill(base), ...Array(extra).fill(base + 1)],
			});
		}
	}
	return out;
}

function bestRated(n: number, area: McArea): { shape: McShape; score: number } {
	const rated = candidates(n).map((shape) => ({ shape, ...rate(shape, area) }));
	const top = Math.max(...rated.map((r) => r.score));
	const floor = top - TIE * Math.abs(top);
	// Never empty: the top scorer is in it. More lines must win by more than
	// rounding: a 3x2 dealt as rows and as columns is one grid, and the first
	// in candidate order keeps it.
	return rated
		.filter((r) => r.score >= floor)
		.reduce((best, r) => (r.lines > best.lines + 1e-6 ? r : best));
}

/**
 * How Auto lays out a page of `n` tiles in `area`: the shape whose smallest
 * tile is most readable, close calls going to the one with the most lines.
 * Every tile has a cell and every cell a tile.
 */
export function bestMcShape(n: number, area: McArea): McShape {
	if (n <= 0) return { flow: "rows", lines: [] };
	return bestRated(n, area).shape;
}

// The most tiles one page holds in `area` with the smallest scoring at least
// `floor`; never fewer than one. A tile more never scores better (each line
// only gains tiles), so the first miss ends the search.
function capacityAt(area: McArea, floor: number): number {
	let n = 1;
	while (n < MAX_PAGE && bestRated(n + 1, area).score >= floor) n++;
	return n;
}

/**
 * How many tiles a page holds under Auto. Given the count the grid had
 * before (`prev`), it keeps it while the space still fits it within MARGIN of
 * the floor, so only a real change of space re-pages the tiles.
 */
export function mcCapacity(area: McArea, prev?: number): number {
	if (prev === undefined) return capacityAt(area, FLOOR);
	const lo = capacityAt(area, FLOOR + MARGIN);
	const hi = capacityAt(area, FLOOR - MARGIN);
	return Math.min(hi, Math.max(lo, prev));
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * The CSS grid that draws a shape: the container's tracks, and each tile's
 * span in order. Lines hold different counts (say 2 and 3), so the tracks
 * along a line are the counts' least common multiple and a tile spans its
 * line's share of them.
 */
export function mcShapeGrid(shape: McShape): {
	container: {
		gridTemplateColumns: string;
		gridTemplateRows: string;
		gridAutoFlow: "row" | "column";
	};
	tiles: ({ gridColumn: string } | { gridRow: string })[];
} {
	const tracks = shape.lines.reduce((m, n) => (m * n) / gcd(m, n), 1);
	const across = `repeat(${shape.lines.length}, minmax(0, 1fr))`;
	const along = `repeat(${tracks}, minmax(0, 1fr))`;
	const rows = shape.flow === "rows";
	return {
		container: {
			gridTemplateColumns: rows ? along : across,
			gridTemplateRows: rows ? across : along,
			gridAutoFlow: rows ? "row" : "column",
		},
		tiles: shape.lines.flatMap((n) =>
			Array.from({ length: n }, () =>
				rows ? { gridColumn: `span ${tracks / n}` } : { gridRow: `span ${tracks / n}` },
			),
		),
	};
}

// ---- tiles arriving ----

/**
 * The tiles once new ones arrive. The tiles already placed keep their slots.
 * Each arrival goes where it was dropped (before the tile `place` names for
 * it), or at the end when it has no spot, was dropped off the tiles (null),
 * or the tile it was dropped on is gone. Arrivals land in the order given,
 * so two dropped on the same tile line up in that order before it.
 */
export function placeArrivals<T>(
	kept: T[],
	arrived: T[],
	idOf: (t: T) => string,
	place: ReadonlyMap<string, string | null>,
): T[] {
	const next = [...kept];
	for (const t of arrived) {
		const before = place.get(idOf(t));
		const at = before ? next.findIndex((x) => idOf(x) === before) : -1;
		if (at < 0) next.push(t);
		else next.splice(at, 0, t);
	}
	return next;
}
