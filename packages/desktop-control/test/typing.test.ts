import { expect, test } from "bun:test";
import { typingParts } from "../src/x11";

test("long text is typed in bounded pieces that rebuild it exactly", () => {
	const text = `${"é".repeat(1200)}日本語😀\r\nnext\tline`;
	const parts = typingParts(text);
	for (const part of parts)
		if ("text" in part) expect(Array.from(part.text).length).toBeLessThanOrEqual(500);
	const rebuilt = parts
		.map((p) => ("key" in p ? (p.key === "Return" ? "\n" : "\t") : p.text))
		.join("");
	expect(rebuilt).toBe(text.replace(/\r\n?/g, "\n"));
	expect(parts.filter((p) => "key" in p)).toEqual([{ key: "Return" }, { key: "Tab" }]);
});

test("a piece boundary never splits a surrogate pair", () => {
	const parts = typingParts("😀".repeat(3), 2);
	expect(parts).toEqual([{ text: "😀😀" }, { text: "😀" }]);
});
