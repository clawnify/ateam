import { describe, expect, it } from "bun:test";
import type { BoxLinkDTO } from "@ateam/protocol";
import { linkUrlOf, pairLinkOf, planLinks } from "./cross-box-plan";

const v30 = (alias: string, wsAddr: string | null = null) => ({ alias, version: 30, wsAddr });
const link = (name: string, url: string): BoxLinkDTO => ({
	name,
	url,
	state: "connected",
	device: null,
});

describe("where other boxes reach a box", () => {
	it("at the address it is held by, or the one its hello gave", () => {
		expect(linkUrlOf(v30("100.64.0.2:8787"))).toEqual({ url: "ws://100.64.0.2:8787" });
		expect(linkUrlOf(v30("hetzner", "100.64.0.3:8787"))).toEqual({ url: "ws://100.64.0.3:8787" });
		expect(linkUrlOf(v30("v6", "fd7a:115c::5:8787"))).toEqual({ url: "ws://[fd7a:115c::5]:8787" });
	});

	it("nowhere, with why, when it has no port or one only it can reach", () => {
		expect(linkUrlOf(v30("hetzner"))).toMatchObject({
			problem: expect.stringContaining("no network port"),
		});
		expect(linkUrlOf(v30("sprite", "127.0.0.1:8787"))).toMatchObject({
			problem: expect.stringContaining("127.0.0.1"),
		});
	});
});

describe("the QR for pairing a phone", () => {
	it("names the box where the phone reaches it, even one the Mac reaches over SSH", () => {
		expect(pairLinkOf(v30("100.94.46.10:8787"), "FC8HQGMZ")).toBe(
			"ateamgo://pair?host=100.94.46.10&port=8787&code=FC8HQGMZ",
		);
		expect(pairLinkOf(v30("ateam-probe.boxd", "100.81.40.73:8787"), "FC8HQGMZ")).toBe(
			"ateamgo://pair?host=100.81.40.73&port=8787&code=FC8HQGMZ",
		);
		expect(pairLinkOf(v30("v6", "fd7a:115c::5:8787"), "FC8HQGMZ")).toBe(
			"ateamgo://pair?host=%5Bfd7a%3A115c%3A%3A5%5D&port=8787&code=FC8HQGMZ",
		);
	});

	it("has none for a box no other device can reach", () => {
		expect(pairLinkOf(v30("hetzner"), "FC8HQGMZ")).toBeNull();
		expect(pairLinkOf(v30("ateam-probe.boxd", "127.0.0.1:8787"), "FC8HQGMZ")).toBeNull();
	});
});

describe("the links each box should hold", () => {
	const none = new Map<string, BoxLinkDTO[]>();

	it("links every held box to every other one, by its alias", () => {
		const { want, problems } = planLinks({
			on: true,
			held: [v30("alpha", "100.64.0.1:8787"), v30("beta", "100.64.0.2:8787")],
			known: new Set(["alpha", "beta"]),
			current: none,
		});
		expect(want.get("alpha")).toEqual([{ name: "beta", url: "ws://100.64.0.2:8787" }]);
		expect(want.get("beta")).toEqual([{ name: "alpha", url: "ws://100.64.0.1:8787" }]);
		expect(problems.size).toBe(0);
	});

	it("leaves out a box too old for links, and says to update it", () => {
		const { want, problems } = planLinks({
			on: true,
			held: [
				v30("alpha", "100.64.0.1:8787"),
				{ alias: "old", version: 29, wsAddr: "100.64.0.9:8787" },
			],
			known: new Set(["alpha", "old"]),
			current: none,
		});
		expect(want.get("alpha")).toEqual([]);
		expect(want.has("old")).toBe(false);
		expect(problems.get("old")).toContain("Update it");
	});

	it("still links a box the others can't reach to them", () => {
		const { want, problems } = planLinks({
			on: true,
			held: [v30("alpha", "100.64.0.1:8787"), v30("sprite", "127.0.0.1:8787")],
			known: new Set(["alpha", "sprite"]),
			current: none,
		});
		expect(want.get("sprite")).toEqual([{ name: "alpha", url: "ws://100.64.0.1:8787" }]);
		expect(want.get("alpha")).toEqual([]);
		expect(problems.get("sprite")).toContain("127.0.0.1");
	});

	it("keeps a link to a box this Mac isn't holding now, and drops one to a box it forgot", () => {
		const { want } = planLinks({
			on: true,
			held: [v30("alpha", "100.64.0.1:8787")],
			known: new Set(["alpha", "away"]),
			current: new Map([
				[
					"alpha",
					[link("away", "ws://100.64.0.4:8787"), link("forgotten", "ws://100.64.0.5:8787")],
				],
			]),
		});
		expect(want.get("alpha")).toEqual([{ name: "away", url: "ws://100.64.0.4:8787" }]);
	});

	it("wants no links at all when it is off", () => {
		const { want } = planLinks({
			on: false,
			held: [v30("alpha", "100.64.0.1:8787"), v30("beta", "100.64.0.2:8787")],
			known: new Set(["alpha", "beta"]),
			current: new Map([["alpha", [link("beta", "ws://100.64.0.2:8787")]]]),
		});
		expect(want.get("alpha")).toEqual([]);
		expect(want.get("beta")).toEqual([]);
	});

	it("never links a box to itself, held under two names", () => {
		const { want } = planLinks({
			on: true,
			held: [v30("hetzner", "100.64.0.2:8787"), v30("100.64.0.2:8787")],
			known: new Set(["hetzner", "100.64.0.2:8787"]),
			current: none,
		});
		expect(want.get("hetzner")).toEqual([]);
		expect(want.get("100.64.0.2:8787")).toEqual([]);
	});
});
