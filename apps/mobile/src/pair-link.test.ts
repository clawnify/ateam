import { expect, test } from "bun:test";
import { pairTarget, parsePairLink } from "./pair-link";

test("reads the box and code from the link a Mac's QR holds", () => {
	expect(parsePairLink("ateamgo://pair?host=100.81.40.73&port=8787&code=FC8HQGMZ")).toEqual({
		box: { host: "100.81.40.73", port: "8787" },
		code: "FC8HQGMZ",
	});
	expect(parsePairLink("ateamgo://pair?host=box.tail1234.ts.net&code=FC8H-QGMZ")?.box.port).toBe(
		"8787",
	);
	expect(
		parsePairLink("ateamgo://pair?host=%5Bfd7a%3A%3A1%5D&port=8787&code=FC8HQGMZ")?.box.host,
	).toBe("[fd7a::1]");
});

test("drops anything that isn't a plain host, port and code", () => {
	for (const url of [
		"ateamgo://pair?host=evil.example/path&code=FC8HQGMZ",
		"ateamgo://pair?host=a@b&code=FC8HQGMZ",
		"ateamgo://pair?host=100.81.40.73&port=99999&code=FC8HQGMZ",
		"ateamgo://pair?host=100.81.40.73&port=80a&code=FC8HQGMZ",
		"ateamgo://pair?host=100.81.40.73&code=short",
		"ateamgo://pair?host=100.81.40.73&code=%E0%A4%A",
		"ateamgo://pair?code=FC8HQGMZ",
		"ateamgo://demo?host=100.81.40.73&code=FC8HQGMZ",
	])
		expect(parsePairLink(url)).toBeNull();
});

test("a link for a box already on the list pairs it as saved, so it can still be woken", () => {
	const sprite = {
		host: "100.94.46.10",
		port: "8787",
		provider: { id: "sprites", box: { machine: "ateam-box" } },
		lastUsedAt: 1,
	};
	const link = parsePairLink("ateamgo://pair?host=100.94.46.10&port=8787&code=FC8HQGMZ");
	if (!link) throw new Error("link didn't parse");
	expect(pairTarget([sprite], link)).toBe(sprite);
	// The same box written another way still matches (case, default port).
	const bare = parsePairLink("ateamgo://pair?host=Box.Tail1234.ts.net&code=FC8HQGMZ");
	if (!bare) throw new Error("link didn't parse");
	const named = { host: "box.tail1234.ts.net", port: "", lastUsedAt: 2 };
	expect(pairTarget([sprite, named], bare)).toBe(named);
	// A box that isn't there is added as the link names it.
	expect(pairTarget([named], link)).toEqual({ host: "100.94.46.10", port: "8787" });
});
