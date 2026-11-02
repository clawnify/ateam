import { describe, expect, it } from "bun:test";
import type { ConnectionDTO } from "@ateam/protocol";
import type { HostStatus } from "../../shared/host";
import { boxRows, engineLabel } from "./boxes-settings";

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
const held = (alias: string, protocolVersion: number): HostStatus => ({
	mode: "remote",
	alias,
	info: { protocolVersion, agents: [] },
});

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
		[held("probe.boxd", 25)],
		{ "old-ssh": "ssh: connect timed out" },
		25,
	);

	it("lists only boxes this Mac has used, connected first, then asleep, then the rest", () => {
		expect(rows.map((r) => r.alias)).toEqual(["probe.boxd", "100.1.2.3:8787", "old-ssh"]);
		expect(rows.map((r) => r.state)).toEqual(["connected", "asleep", "offline"]);
	});

	it("takes the live engine version over the last one seen", () => {
		expect(rows[0]).toMatchObject({ version: 25, engine: "current" });
		expect(engineLabel(rows[0] as never)).toBe("engine v25, up to date");
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
		const [r] = boxRows([conn({ alias: "x" })], [], {}, 25);
		expect(r?.engine).toBe("unknown");
	});
});
