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

export const MC_CHOICES: { value: McChoice; label: string }[] = [
	{ value: "auto", label: "Auto" },
	{ value: "grid", label: "Grid" },
	{ value: "grid3x2", label: "3 × 2" },
	{ value: "main", label: "Main + side" },
	{ value: "split", label: "Split" },
	{ value: "stack", label: "Stack" },
];

export const MC_RESIZE_SETTLE_MS = 200;
export const MC_REORDER_DELAY_MS = 5_000;

/** Fixed layouts leave unused slots empty; Auto fills every slot. */
export function fixedMcShape(layout: McLayout): McShape {
	switch (layout) {
		case "grid":
			return { flow: "rows", lines: [2, 2] };
		case "grid3x2":
			return { flow: "rows", lines: [3, 3] };
		case "main":
			return { flow: "cols", lines: [1, 2] };
		case "split":
			return { flow: "rows", lines: [2] };
		case "stack":
			return { flow: "rows", lines: [1] };
	}
}

/** Native frames for the same shapes drawn by mcShapeGrid on desktop. */
export function mcShapeRects(shape: McShape, area: McArea) {
	const rows = shape.flow === "rows";
	return shape.lines.flatMap((n, line) =>
		Array.from({ length: n }, (_, slot) => ({
			left: area.width * (rows ? slot / n : line / shape.lines.length),
			top: area.height * (rows ? line / shape.lines.length : slot / n),
			width: area.width / (rows ? n : shape.lines.length),
			height: area.height / (rows ? shape.lines.length : n),
		})),
	);
}

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
// The smallest terminal a page holds: a page keeps adding tiles while every
// one keeps at least this many columns and lines. Width is what breaks first:
// Claude Code spends 18 columns on a diff's gutter, so at 60 columns 8% of
// real code lines wrap onto three rows or more, against 30% at 48 and 17% at
// 56 (measured on this repo and a Python one). Height goes to the agent's own
// chrome first: Claude Code's spinner, input box and footer keep 8 to 13 rows
// at the bottom, depending on the status line, and its output shows in what's
// left. Three tiles stacked in a laptop's column get 17 lines, a strip of five
// rows of output; two rows of tiles on a 13-inch laptop get 21. The floor sits
// between them, so a small laptop keeps two rows and no column stacks three.
const MIN_COLS = 60;
const MIN_LINES = 20;
// A resize moves the page size only once the space has moved this share past
// the smallest terminal (3 of the 60 columns), so a grid sitting at a boundary
// doesn't flip its pages back and forth as the window settles. Kept small: a
// laptop's 3x2 sits at 64 columns, and closing the Lead must grow a page of
// four back to six.
const MARGIN = 0.05;
// Shapes within this share of the best score tie, and the tie goes to the one
// showing the most terminal lines in all: the spare room lands as height.
const TIE = 0.05;
// How wide a tile may be, over its height, and still count as square. Tiles
// stand up first, square ones next, and tiles lie down (wider than this) only
// when no other shape keeps every terminal readable: people want their
// terminals tall, or square at worst.
const SQUARE = 1.2;
// The most tiles a page is ever asked to hold, a bound for the search only.
const MAX_PAGE = 36;

// A tile's terminal size, in columns and lines.
const termCols = (width: number) => (width - CHROME_W) / CELL_W;
const termLines = (height: number) => (height - CHROME_H) / CELL_H;

// How a shape's widest tile sits: 0 every tile stands (no wider than tall),
// 1 the widest is about square, 2 some tile lies down.
type Stance = 0 | 1 | 2;
const stanceOf = (aspect: number): Stance => (aspect <= 1 ? 0 : aspect <= SQUARE ? 1 : 2);

// The shape, as its smallest tile sees it: `fit` against the smallest
// terminal (1 is exactly that, below 1 it doesn't read) and `score` against
// the 80 by 30 target, which says which of two readable shapes reads better.
// Then the terminal lines it shows in all, and how its widest tile sits.
function rate(
	shape: McShape,
	area: McArea,
): { fit: number; score: number; lines: number; stance: Stance } {
	const k = shape.lines.length;
	let fit = Number.POSITIVE_INFINITY;
	let score = Number.POSITIVE_INFINITY;
	let lines = 0;
	let aspect = 0;
	for (const n of shape.lines) {
		const w = shape.flow === "rows" ? area.width / n : area.width / k;
		const h = shape.flow === "rows" ? area.height / k : area.height / n;
		const [c, l] = [termCols(w), termLines(h)];
		fit = Math.min(fit, c / MIN_COLS, l / MIN_LINES);
		score = Math.min(score, c / TARGET_COLS, l / TARGET_LINES);
		lines += n * l;
		aspect = Math.max(aspect, w / h);
	}
	return { fit, score, lines, stance: stanceOf(aspect) };
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

const rateAll = (n: number, area: McArea) =>
	candidates(n).map((shape) => ({ shape, ...rate(shape, area) }));

// The best fit any shape of n tiles reaches in `area`.
const topFit = (n: number, area: McArea): number => Math.max(...rateAll(n, area).map((r) => r.fit));

/**
 * How Auto lays out a page of `n` tiles in `area`. Of the shapes that keep
 * every terminal readable, those whose tiles stand up win, then square ones,
 * and tiles lie down only when nothing else reads. Among those, the shape
 * whose smallest tile is most readable, close calls going to the one with the
 * most lines. Every tile has a cell and every cell a tile.
 */
export function bestMcShape(n: number, area: McArea): McShape {
	if (n <= 0) return { flow: "rows", lines: [] };
	const rated = rateAll(n, area);
	// Each step keeps the top of what it filters by, so none comes up empty.
	const near = <T>(rs: T[], by: (r: T) => number) => {
		const best = Math.max(...rs.map(by));
		return rs.filter((r) => by(r) >= best - TIE * Math.abs(best));
	};
	// Readable: the smallest terminal fits. A page the resize margin holds past
	// its size may have no shape that fits, and then the closest ones are.
	const fitting = rated.filter((r) => r.fit >= 1);
	const readable = fitting.length > 0 ? fitting : near(rated, (r) => r.fit);
	const stance = Math.min(...readable.map((r) => r.stance));
	// More lines must win by more than rounding: a 3x2 dealt as rows and as
	// columns is one grid, and the first in candidate order keeps it.
	return near(
		readable.filter((r) => r.stance === stance),
		(r) => r.score,
	).reduce((most, r) => (r.lines > most.lines + 1e-6 ? r : most)).shape;
}

// The most tiles one page holds in `area` with some shape's smallest tile
// fitting at least `floor` of the smallest terminal; never fewer than one. A
// tile more never fits better (each line only gains tiles), so the first miss
// ends the search.
function capacityAt(area: McArea, floor: number): number {
	let n = 1;
	while (n < MAX_PAGE && topFit(n + 1, area) >= floor) n++;
	return n;
}

/**
 * How many tiles a page holds under Auto. Given the count the grid had
 * before (`prev`), it keeps it while the space still fits it within MARGIN of
 * the smallest terminal, so only a real change of space re-pages the tiles.
 */
export function mcCapacity(area: McArea, prev?: number): number {
	if (prev === undefined) return capacityAt(area, 1);
	const lo = capacityAt(area, 1 + MARGIN);
	const hi = capacityAt(area, 1 - MARGIN);
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
