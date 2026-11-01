// The emoji set behind the emoji pickers (frimousse), bundled. frimousse's own
// loader fetches it from a CDN, which the window's Content-Security-Policy
// blocks, and a packaged build is a file:// page that can't fetch at all. So
// the set ships with the app, as its own chunk loaded on a picker's first open.
import type { EmojiData, EmojiDataResolver } from "frimousse";

type Emoji = typeof import("emojibase-data/en/data.json")["default"][number];

/** frimousse's names for Emojibase's skin tones 1 to 5. */
const TONES = ["light", "medium-light", "medium", "medium-dark", "dark"] as const;

/** The fonts frimousse draws its emoji in. */
const EMOJI_FONT = "'Apple Color Emoji', 'Noto Color Emoji', 'Segoe UI Emoji', sans-serif";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Whether the emoji font draws `emoji` as one colour glyph. Drawn twice in
 *  two colours, a colour glyph comes out the same both times; a missing one (a
 *  box, or its parts side by side) takes the colour, or is too wide. */
function draws(ctx: CanvasRenderingContext2D, emoji: string): boolean {
	if (ctx.measureText(emoji).width >= 4) return false;
	const pixels = (fill: string) => {
		ctx.clearRect(0, 0, 2, 2);
		ctx.fillStyle = fill;
		ctx.fillText(emoji, 0, 0);
		return ctx.getImageData(0, 0, 2, 2).data;
	};
	const blue = pixels("#00f");
	const red = pixels("#f00");
	return blue.every((v, i) => i % 4 === 3 || v === red[i]);
}

/** The newest Emoji version this Mac can draw, found by drawing the first
 *  emoji of each version, newest first. The check frimousse runs on the set it
 *  fetches and skips for one handed to it, so it is done here. */
function newestDrawn(emojis: Emoji[]): number {
	const first = new Map<number, string>();
	for (const e of emojis) if (!first.has(e.version)) first.set(e.version, e.emoji);
	const versions = [...first.keys()].sort((a, b) => b - a);
	const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
	if (!ctx) return versions[0] ?? 0;
	ctx.canvas.width = 2;
	ctx.canvas.height = 2;
	ctx.font = `2px ${EMOJI_FONT}`;
	ctx.textBaseline = "middle";
	return versions.find((v) => draws(ctx, first.get(v) ?? "")) ?? versions[0] ?? 0;
}

/** Emojibase's English set in frimousse's shape, as its own loader builds it. */
async function load(): Promise<EmojiData> {
	const [{ default: data }, { default: messages }] = await Promise.all([
		import("emojibase-data/en/data.json"),
		import("emojibase-data/en/messages.json"),
	]);
	// Without a group: the regional letters and skin swatches, never picked alone.
	const grouped = data.filter((e) => e.group !== undefined);
	const newest = newestDrawn(grouped);
	return {
		locale: "en",
		categories: messages.groups
			.filter((g) => g.key !== "component")
			.map((g) => ({ index: g.order, label: capitalize(g.message) })),
		skinTones: Object.fromEntries(
			messages.skinTones.map((t) => [t.key, capitalize(t.message)]),
		) as EmojiData["skinTones"],
		emojis: grouped
			.filter((e) => e.version <= newest)
			.map((e) => {
				const toned = e.skins?.filter((s) => typeof s.tone === "number");
				return {
					emoji: e.emoji,
					category: e.group ?? 0,
					version: e.version,
					label: capitalize(e.label),
					tags: e.tags ?? [],
					skins: toned?.length
						? (Object.fromEntries(
								toned.map((s) => [TONES[(s.tone as number) - 1], s.emoji]),
							) as EmojiData["emojis"][number]["skins"])
						: undefined,
				};
			}),
	};
}

let loading: Promise<EmojiData> | undefined;

/** For a picker's `resolveEmojiData`: built once, then shared by every picker. */
export const resolveEmojiData: EmojiDataResolver = () => {
	loading ??= load().catch((err) => {
		loading = undefined;
		throw err;
	});
	return loading;
};
