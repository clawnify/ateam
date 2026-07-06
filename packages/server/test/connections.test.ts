import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repo } from "@ateam/db";
import { createTestDb } from "../../db/test/helpers/test-db";
import { listConnections, readSshHosts, recordConnection } from "../src/connections";

function writeConfig(content: string): string {
	const p = join(mkdtempSync(join(tmpdir(), "ateam-ssh-")), "config");
	writeFileSync(p, content);
	return p;
}

describe("readSshHosts", () => {
	it("parses aliases + HostName, sharing options across a multi-alias stanza", () => {
		const cfg = writeConfig(
			[
				"# a comment",
				"Host hetzner-devbox",
				"  HostName 100.72.63.61",
				"  User pallaoro",
				"",
				"Host prod staging",
				"  HostName example.com",
				"",
				"Host *",
				"  ForwardAgent yes",
			].join("\n"),
		);
		const hosts = readSshHosts(cfg);
		// Wildcard `*` stanza excluded; multi-alias stanza yields both, sharing HostName.
		expect(hosts.map((h) => h.alias)).toEqual(["hetzner-devbox", "prod", "staging"]);
		expect(hosts.find((h) => h.alias === "hetzner-devbox")?.hostName).toBe("100.72.63.61");
		expect(hosts.find((h) => h.alias === "prod")?.hostName).toBe("example.com");
		expect(hosts.find((h) => h.alias === "staging")?.hostName).toBe("example.com");
	});

	it("returns [] when the config file is missing", () => {
		expect(readSshHosts(join(tmpdir(), "definitely-no-ssh-config-xyz"))).toEqual([]);
	});
});

describe("listConnections", () => {
	it("merges ssh_config hosts with saved records and sorts by recency", () => {
		const db = createTestDb();
		const cfg = writeConfig("Host box-a\n  HostName 10.0.0.1\nHost box-b\n  HostName 10.0.0.2\n");
		// box-a connected just now; box-b in config but never connected; box-gone
		// saved but no longer in the config.
		recordConnection(db, {
			hostAlias: "box-a",
			serverVersion: "1.2.3",
			agentsAvailable: ["claude"],
		});
		repo.upsertHost(db, { hostAlias: "box-gone", lastSeen: 5, serverVersion: "0.9" });

		const conns = listConnections(db, cfg);
		const byAlias = Object.fromEntries(conns.map((c) => [c.alias, c]));

		expect(byAlias["box-a"]?.known).toBe(true);
		expect(byAlias["box-a"]?.inSshConfig).toBe(true);
		expect(byAlias["box-a"]?.serverVersion).toBe("1.2.3");
		expect(byAlias["box-a"]?.hostName).toBe("10.0.0.1");

		expect(byAlias["box-b"]?.known).toBe(false);
		expect(byAlias["box-b"]?.inSshConfig).toBe(true);
		expect(byAlias["box-b"]?.lastSeen).toBeNull();

		expect(byAlias["box-gone"]?.known).toBe(true);
		expect(byAlias["box-gone"]?.inSshConfig).toBe(false);

		// box-a (fresh lastSeen) first; box-b (never connected) last.
		expect(conns[0]?.alias).toBe("box-a");
		expect(conns.at(-1)?.alias).toBe("box-b");
	});
});

describe("recordConnection", () => {
	it("stamps lastSeen and preserves cached fields on a bare touch", () => {
		const db = createTestDb();
		recordConnection(db, {
			hostAlias: "box",
			serverVersion: "1.0.0",
			agentsAvailable: ["claude", "codex"],
		});
		recordConnection(db, { hostAlias: "box" }); // touch only

		const h = repo.getHost(db, "box");
		expect(h?.serverVersion).toBe("1.0.0");
		expect(h?.agentsAvailable).toEqual(["claude", "codex"]);
		expect(typeof h?.lastSeen).toBe("number");
	});
});
