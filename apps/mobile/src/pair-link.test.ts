import { expect, test } from "bun:test";
import { parsePairLink } from "./pair-link";

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
