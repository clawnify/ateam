import { describe, expect, it } from "bun:test";
import type { ConnectionDTO, GithubAccessDTO } from "@ateam/protocol";
import type { HostStatus } from "../../shared/host";
import { boxesNeedingYou, boxRows, compareReleases, engineLabel } from "./boxes-settings";

const conn = (over: Partial<ConnectionDTO>): ConnectionDTO => ({
	alias: "box",
	transport: "ssh",
	hostName: null,
	serverVersion: null,
	agentsAvailable: null,
	lastSeen: null,
	inSshConfig: true,
	known: true,
	...over,
});
const held = (alias: string, protocolVersion: number, release?: string): HostStatus => ({
	mode: "remote",
	alias,
	info: { protocolVersion, agents: [], ...(release ? { release } : {}) },
});
const app = { protocol: 25, release: "0.1.80" };

describe("boxRows", () => {
	const rows = boxRows(
		[
			conn({ alias: "old-ssh", serverVersion: "12", lastSeen: 100 }),
			conn({ alias: "probe.boxd", serverVersion: "24", lastSeen: 300 }),
			conn({
				alias: "100.1.2.3:8787",
				transport: "ws",
				serverVersion: "24",
				lastSeen: 200,
				asleep: true,
				wake: { id: "sprites", box: { machine: "my-sprite" } },
			}),
			conn({ alias: "never-ran-ateam", known: false }),
		],
		[held("probe.boxd", 25, "0.1.80")],
		{ "old-ssh": "ssh: connect timed out" },
		app,
	);

	it("lists only boxes this Mac has used, connected first, then asleep, then the rest", () => {
		expect(rows.map((r) => r.alias)).toEqual(["probe.boxd", "100.1.2.3:8787", "old-ssh"]);
		expect(rows.map((r) => r.state)).toEqual(["connected", "asleep", "offline"]);
	});

	it("takes the live engine version over the last one seen", () => {
		expect(rows[0]).toMatchObject({ version: 25, release: "0.1.80", engine: "current" });
		expect(engineLabel(rows[0] as never)).toBe("engine 0.1.80, up to date");
	});

	it("names a provider box by its machine and says how it's reached", () => {
		expect(rows[1]).toMatchObject({
			title: "my-sprite",
			detail: "Sprites · Tailscale 100.1.2.3:8787",
			transport: "ws",
			engine: "behind",
		});
	});

	it("keeps why the last connect failed", () => {
		expect(rows[2]).toMatchObject({
			failure: "ssh: connect timed out",
			engine: "behind",
			version: 12,
		});
	});

	it("says it can't tell a version it never saw", () => {
		const [r] = boxRows([conn({ alias: "x" })], [], {}, app);
		expect(r?.engine).toBe("unknown");
	});
});

describe("a box's network port", () => {
	const withPort = (alias: string, wsAddr?: string | null): HostStatus => ({
		mode: "remote",
		alias,
		info: { protocolVersion: 30, agents: [], ...(wsAddr !== undefined ? { wsAddr } : {}) },
	});
	const rows = boxRows(
		[
			conn({ alias: "on-tailnet" }),
			conn({ alias: "ssh-only" }),
			conn({ alias: "older" }),
			conn({ alias: "away" }),
		],
		[withPort("on-tailnet", "100.64.0.7:8787"), withPort("ssh-only", null), withPort("older")],
		{},
		app,
	);
	const port = (alias: string) => rows.find((r) => r.alias === alias)?.networkPort;

	it("is where the connected engine listens, or null when it has none", () => {
		expect(port("on-tailnet")).toBe("100.64.0.7:8787");
		expect(port("ssh-only")).toBeNull();
	});

	it("is unknown for an engine that didn't say, and for a box not connected", () => {
		expect(port("older")).toBeUndefined();
		expect(port("away")).toBeUndefined();
	});
});

describe("an engine on this app's protocol", () => {
	const row = (over: Partial<ConnectionDTO>, live?: HostStatus) =>
		boxRows([conn({ alias: "b", serverVersion: "25", ...over })], live ? [live] : [], {}, app)[0];

	it("is behind on an older release, and keeps its GitHub panel", () => {
		const r = row({ engineRelease: "0.1.79" });
		expect(r).toMatchObject({ engine: "behind", githubReady: true });
		expect(engineLabel(r as never)).toBe("engine 0.1.79, update available");
	});

	it("is behind when it names no release: it predates reporting one", () => {
		const r = row({}, held("b", 25));
		expect(r?.engine).toBe("behind");
		expect(engineLabel(r as never)).toBe("engine v25, update available");
	});

	it("takes the live release over the one last seen", () => {
		expect(row({ engineRelease: "0.1.79" }, held("b", 25, "0.1.80"))?.engine).toBe("current");
	});

	it("is ahead on a newer release", () => {
		expect(row({ engineRelease: "0.1.81" })?.engine).toBe("ahead");
	});

	it("needs protocol 25 for its GitHub panel", () => {
		expect(row({ serverVersion: "24" })?.githubReady).toBe(false);
	});
});

describe("compareReleases", () => {
	it("orders releases by number, not by text", () => {
		expect(compareReleases("0.1.79", "0.1.80")).toBeLessThan(0);
		expect(compareReleases("0.1.100", "0.1.99")).toBeGreaterThan(0);
		expect(compareReleases("0.2.0", "0.1.99")).toBeGreaterThan(0);
		expect(compareReleases("0.1.80", "0.1.80")).toBe(0);
	});
});

describe("boxesNeedingYou", () => {
	const now = Date.parse("2026-11-02T00:00:00Z");
	const day = 86_400_000;
	const token = (expiresInDays: number, rejected = false): GithubAccessDTO => ({
		ghInstalled: true,
		gh: {
			kind: "fine-grained",
			hint: "wxyz",
			login: "octo",
			rejected,
			expiresAt: now + expiresInDays * day,
			source: "store",
		},
		git: "gh",
		gitCredential: null,
		unverified: null,
	});
	const rows = boxRows(
		[
			conn({ alias: "fresh", serverVersion: "25", engineRelease: "0.1.80" }),
			conn({ alias: "expiring", serverVersion: "25", engineRelease: "0.1.80" }),
			conn({ alias: "refused", serverVersion: "25", engineRelease: "0.1.80" }),
			conn({ alias: "old-release", serverVersion: "25", engineRelease: "0.1.79" }),
			conn({ alias: "asleep-old", serverVersion: "12", asleep: true }),
		],
		["fresh", "expiring", "refused", "old-release"].map((a) =>
			held(a, 25, a === "old-release" ? "0.1.79" : "0.1.80"),
		),
		{},
		app,
	);

	it("marks connected boxes a release behind, or with a token to renew", () => {
		const needing = boxesNeedingYou(
			rows,
			{ fresh: token(60), expiring: token(5), refused: token(60, true) },
			now,
		);
		expect([...needing].sort()).toEqual(["expiring", "old-release", "refused"]);
	});

	it("leaves out a box it isn't connected to, however old", () => {
		expect(boxesNeedingYou(rows, {}, now).has("asleep-old")).toBe(false);
	});
});
