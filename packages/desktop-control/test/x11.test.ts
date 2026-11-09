import { expect, test } from "bun:test";
import { parseKeymap, planKeys } from "../src/x11";

// Shape of `xmodmap -pk` on Xvfb: empty keycodes print no keysyms.
const sample = [
	"There are 7 KeySyms per KeyCode; KeyCodes range from 8 to 255.",
	"",
	"    KeyCode\tKeysym (Keysym)\t...",
	"    Value  \tValue   (Name) \t...",
	"",
	"      8    \t",
	"     38    \t0x0061 (a)\t0x0041 (A)\t0x0061 (a)\t0x0041 (A)\t",
	"     65    \t0x0020 (space)\t0x0000 (NoSymbol)\t0x0020 (space)\t",
	"     93    \t",
	"     97    \t",
	"    103    \t",
	"    120    \t",
	"    150    \t0x00e9 (eacute)\t0x00c9 (Eacute)\t0x00e9 (eacute)\t0x00c9 (Eacute)\t",
	"    248    \t",
].join("\n");
const U = (c: string) => 0x1000000 + (c.codePointAt(0) ?? 0);

test("parseKeymap reads keysyms per keycode and drops NoSymbol", () => {
	const keymap = parseKeymap(sample);
	expect(keymap.get(8)).toEqual([]);
	expect(keymap.get(38)).toEqual([0x61, 0x41, 0x61, 0x41]);
	expect(keymap.get(65)).toEqual([0x20, 0x20]);
	expect(keymap.size).toBe(9);
});

test("every missing character gets its own keycode, the lowest and highest empty stay free", () => {
	const runs = planKeys("ñ 日本 ñ 日", parseKeymap(sample), new Map());
	expect(runs).toEqual([
		{
			text: "ñ 日本 ñ 日",
			map: [
				[93, 0xf1],
				[97, U("日")],
				[103, U("本")],
			],
			overwrite: false,
		},
	]);
});

test("characters already in the keymap and plain ASCII need no keycode", () => {
	expect(planKeys("café, Été", parseKeymap(sample), new Map())).toEqual([
		{ text: "café, Été", map: [], overwrite: false },
	]);
});

test("a later call reuses its keycodes and only binds what is new", () => {
	const keymap = parseKeymap(sample);
	keymap.set(93, [U("日"), U("日")]);
	const owned = new Map([[93, U("日")]]);
	expect(planKeys("日本", keymap, owned)).toEqual([
		{ text: "日本", map: [[97, U("本")]], overwrite: false },
	]);
});

test("text needing more keycodes than are free is typed in runs", () => {
	// Free for typing: 93, 97, 103, 120.
	const runs = planKeys("αβγδ αε ζ", parseKeymap(sample), new Map());
	expect(runs.map((r) => r.text)).toEqual(["αβγδ α", "ε ζ"]);
	expect(runs[0]?.overwrite).toBe(false);
	// ε and ζ take the keycodes pressed longest ago (β, γ), not α's.
	expect(runs[1]).toEqual({
		text: "ε ζ",
		map: [
			[97, U("ε")],
			[103, U("ζ")],
		],
		overwrite: true,
	});
});

test("no free keycode leaves typing to xdotool", () => {
	const keymap = parseKeymap(sample);
	for (const code of [93, 97, 103, 120]) keymap.set(code, [0x61]);
	expect(planKeys("日", keymap, new Map())).toEqual([{ text: "日", map: [], overwrite: false }]);
});
