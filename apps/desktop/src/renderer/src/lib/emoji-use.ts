// The emoji answers sent most, for the quick row in front of the full picker.
// Kept on this Mac in localStorage, with the rest of the window's own state, so
// it survives restarts: it is usage, not a choice, so it stays out of
// settings.json, and the Lead's transcript (which also holds them) is archived
// by every new chat.

const KEY = "ateam.emojiUse";

/** How many the quick row shows. */
const QUICK = 5;

type Use = Record<string, { n: number; at: number }>;

function read(): Use {
	try {
		const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
		if (!v || typeof v !== "object") return {};
		return Object.fromEntries(
			Object.entries(v).filter(([, u]) => typeof u?.n === "number" && typeof u?.at === "number"),
		) as Use;
	} catch {
		return {};
	}
}

/** The most sent first (the latest breaks a tie). Empty until one is sent,
 *  and the picker then opens straight on the full set. */
export function topEmoji(): string[] {
	return Object.entries(read())
		.sort(([, a], [, b]) => b.n - a.n || b.at - a.at)
		.slice(0, QUICK)
		.map(([emoji]) => emoji);
}

export function recordEmoji(emoji: string) {
	const use = read();
	use[emoji] = { n: (use[emoji]?.n ?? 0) + 1, at: Date.now() };
	try {
		localStorage.setItem(KEY, JSON.stringify(use));
	} catch {
		// Storage full or off: the row just keeps its last order.
	}
}
