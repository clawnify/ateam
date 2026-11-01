import { beforeEach, expect, setSystemTime, test } from "bun:test";
import { recordEmoji, topEmoji } from "./emoji-use";

const store = new Map<string, string>();
globalThis.localStorage = {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
	clear: () => store.clear(),
	key: () => null,
	length: 0,
} as Storage;

beforeEach(() => store.clear());

test("nothing sent yet: no quick row, so the picker opens on the full set", () => {
	expect(topEmoji()).toEqual([]);
});

test("the most sent first, the latest breaking a tie, five at most", () => {
	const send = (emoji: string, at: number) => {
		setSystemTime(new Date(at));
		recordEmoji(emoji);
	};
	send("👍", 1);
	send("🚀", 2);
	send("🚀", 3);
	send("🎉", 4);
	for (const [i, e] of ["😀", "🙏", "👀"].entries()) send(e, 10 + i);
	setSystemTime();
	// 🚀 twice; the rest once each, newest first; 👍 (the oldest) falls off.
	expect(topEmoji()).toEqual(["🚀", "👀", "🙏", "😀", "🎉"]);
});

test("a broken entry is skipped rather than breaking the row", () => {
	store.set("ateam.emojiUse", JSON.stringify({ "👍": { n: 1, at: 1 }, "🚀": "bad", "🎉": null }));
	expect(topEmoji()).toEqual(["👍"]);
	store.set("ateam.emojiUse", "{not json");
	expect(topEmoji()).toEqual([]);
	recordEmoji("🎉");
	expect(topEmoji()).toEqual(["🎉"]);
});
