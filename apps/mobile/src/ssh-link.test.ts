import { describe, expect, test } from "bun:test";
import { parsePairLinks } from "./pair-link";
import { parseSSHLink } from "./ssh-link";

describe("ateamgo://ssh links", () => {
	test("a provider's machine: its host, port and login, with its hints", () => {
		const link = parseSSHLink(
			"ateamgo://ssh?host=ateam-probe.boxd.sh&port=12836&user=boxd&provider=boxd",
		);
		expect(link?.host).toBe("ateam-probe.boxd.sh");
		expect(link?.port).toBe("12836");
		expect(link?.setup.user).toBe("boxd");
		expect(link?.setup.password?.label).toBe("boxd token");
	});

	test("a bare server: port left to the form, root as the login", () => {
		expect(parseSSHLink("ateamgo://ssh?host=203.0.113.7")).toEqual({
			host: "203.0.113.7",
			port: null,
			setup: { user: "root" },
		});
		expect(parseSSHLink("ateamgo://ssh/?host=%5B2001%3Adb8%3A%3A1%5D&user=ubuntu")).toEqual({
			host: "[2001:db8::1]",
			port: null,
			setup: { user: "ubuntu" },
		});
		// The provider's login unless the link names another.
		expect(parseSSHLink("ateamgo://ssh?host=m.boxd.sh&provider=boxd")?.setup.user).toBe("boxd");
		expect(parseSSHLink("ateamgo://ssh?host=m.boxd.sh&provider=boxd&user=ops")?.setup.user).toBe(
			"ops",
		);
	});

	test("a password or token in the link is never read", () => {
		const link = parseSSHLink("ateamgo://ssh?host=box.example&password=hunter2&token=t");
		expect(JSON.stringify(link)).not.toContain("hunter2");
		expect(JSON.stringify(link)).not.toContain('"t"');
	});

	test("an unknown provider is any server", () => {
		expect(parseSSHLink("ateamgo://ssh?host=box.example&provider=nope")?.setup).toEqual({
			user: "root",
		});
	});

	test("anything malformed opens nothing", () => {
		for (const url of [
			"ateamgo://ssh",
			"ateamgo://ssh?port=22",
			"ateamgo://ssh?host=a%20b",
			"ateamgo://ssh?host=box.example;rm",
			"ateamgo://ssh?host=box.example&port=0",
			"ateamgo://ssh?host=box.example&port=70000",
			"ateamgo://ssh?host=box.example&user=-oProxyCommand",
			"ateamgo://ssh?host=%E0%A4%A",
			"ateamgo://pair?host=box.example&code=ABCD-EFGH",
			"https://ssh?host=box.example",
		]) {
			expect(parseSSHLink(url)).toBeNull();
		}
	});

	test("pairing links still parse the same", () => {
		expect(parsePairLinks("ateamgo://pair?host=100.64.0.1&code=ABCD-EFGH")).toEqual([
			{ box: { host: "100.64.0.1", port: "8787" }, code: "ABCD-EFGH" },
		]);
		expect(parsePairLinks("ateamgo://ssh?host=100.64.0.1")).toBeNull();
	});
});
