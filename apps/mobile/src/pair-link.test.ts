import { expect, test } from "bun:test";
import { type PairLink, pairTarget, parsePairLinks } from "./pair-link";

const one = (url: string): PairLink | undefined => parsePairLinks(url)?.[0];

test("reads the box and code from the link a box's own Pair a phone shows", () => {
	expect(parsePairLinks("ateamgo://pair?host=100.81.40.73&port=8787&code=FC8HQGMZ")).toEqual([
		{ box: { host: "100.81.40.73", port: "8787" }, code: "FC8HQGMZ" },
	]);
	expect(one("ateamgo://pair?host=box.tail1234.ts.net&code=FC8H-QGMZ")?.box.port).toBe("8787");
	expect(one("ateamgo://pair?host=%5Bfd7a%3A%3A1%5D&port=8787&code=FC8HQGMZ")?.box.host).toBe(
		"[fd7a::1]",
	);
});

test("reads every box from Pair your iPhone's link, an open one with no code", () => {
	expect(
		parsePairLinks(
			"ateamgo://pair?b=100.94.46.10%2C8787%2CFC8HQGMZ&b=100.81.40.73%2C8787%2C&b=%5Bfd7a%3A115c%3A%3A5%5D%2C8787%2CK2M4P6Q8",
		),
	).toEqual([
		{ box: { host: "100.94.46.10", port: "8787" }, code: "FC8HQGMZ" },
		{ box: { host: "100.81.40.73", port: "8787" }, code: null },
		{ box: { host: "[fd7a:115c::5]", port: "8787" }, code: "K2M4P6Q8" },
	]);
});

test("drops anything that isn't a plain host, port and code", () => {
	for (const url of [
		"ateamgo://pair?host=evil.example/path&code=FC8HQGMZ",
		"ateamgo://pair?host=a@b&code=FC8HQGMZ",
		"ateamgo://pair?host=100.81.40.73&port=99999&code=FC8HQGMZ",
		"ateamgo://pair?host=100.81.40.73&port=80a&code=FC8HQGMZ",
		"ateamgo://pair?host=100.81.40.73&code=short",
		"ateamgo://pair?host=100.81.40.73&code=%E0%A4%A",
		// The one-box form always has a code: only the many-box form names open boxes.
		"ateamgo://pair?host=100.81.40.73",
		"ateamgo://pair?code=FC8HQGMZ",
		"ateamgo://demo?host=100.81.40.73&code=FC8HQGMZ",
		// One bad box spoils the link, rather than half of it pairing.
		"ateamgo://pair?b=100.94.46.10%2C8787%2CFC8HQGMZ&b=evil.example%2Fx%2C8787%2C",
		"ateamgo://pair?b=100.94.46.10%2C8787%2CFC8HQGMZ%2Cextra",
		`ateamgo://pair?${Array.from({ length: 51 }, (_, i) => `b=10.0.0.${i}%2C8787%2C`).join("&")}`,
	])
		expect(parsePairLinks(url)).toBeNull();
});

test("a link for a box already on the list pairs it as saved, so it can still be woken", () => {
	const sprite = {
		host: "100.94.46.10",
		port: "8787",
		provider: { id: "sprites", box: { machine: "ateam-box" } },
		lastUsedAt: 1,
	};
	const link = one("ateamgo://pair?host=100.94.46.10&port=8787&code=FC8HQGMZ");
	if (!link) throw new Error("link didn't parse");
	expect(pairTarget([sprite], link)).toBe(sprite);
	// The same box written another way still matches (case, default port).
	const bare = one("ateamgo://pair?host=Box.Tail1234.ts.net&code=FC8HQGMZ");
	if (!bare) throw new Error("link didn't parse");
	const named = { host: "box.tail1234.ts.net", port: "", lastUsedAt: 2 };
	expect(pairTarget([sprite, named], bare)).toBe(named);
	// A box that isn't there is added as the link names it.
	expect(pairTarget([named], link)).toEqual({ host: "100.94.46.10", port: "8787" });
});
