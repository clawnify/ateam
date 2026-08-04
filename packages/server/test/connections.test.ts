import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repo } from "@ateam/db";
import { createTestDb } from "../../db/test/helpers/test-db";
import {
	endpointUrl,
	listConnections,
	readSshHosts,
	recordConnection,
	resolveTransport,
} from "../src/connections";

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
				"Host devbox",
				"  HostName 100.64.0.1",
				"  User dev",
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
		expect(hosts.map((h) => h.alias)).toEqual(["devbox", "prod", "staging"]);
		expect(hosts.find((h) => h.alias === "devbox")?.hostName).toBe("100.64.0.1");
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

describe("endpointUrl", () => {
	it("accepts host:port forms and rejects ssh_config aliases", () => {
		expect(endpointUrl("100.72.63.61:8787")).toBe("ws://100.72.63.61:8787");
		expect(endpointUrl("box.tailnet.ts.net:8787")).toBe("ws://box.tailnet.ts.net:8787");
		expect(endpointUrl("[fd7a::1]:8787")).toBe("ws://[fd7a::1]:8787");
		// Aliases have no port, so they can never be mistaken for an endpoint.
		expect(endpointUrl("hetzner-devbox")).toBeNull();
		expect(endpointUrl("my.box.example.com")).toBeNull();
		// Unbracketed IPv6 is ambiguous about where the port starts — reject it.
		expect(endpointUrl("fd7a::1:8787")).toBeNull();
		expect(endpointUrl("host:0")).toBeNull();
		expect(endpointUrl("host:70000")).toBeNull();
		expect(endpointUrl("host:ssh")).toBeNull();
	});
});

describe("resolveTransport", () => {
	const cfg = writeConfig(["Host devbox", "  HostName 100.64.0.1"].join("\n"));

	it("reads an ssh_config alias as ssh and an endpoint as ws", () => {
		const db = createTestDb();
		expect(resolveTransport(db, "devbox", cfg)).toBe("ssh");
		expect(resolveTransport(db, "100.72.63.61:8787", cfg)).toBe("ws");
		expect(resolveTransport(db, "never-heard-of-it", cfg)).toBeNull();
	});

	it("lets a saved row win, so a connection keeps the wire it was made with", () => {
		const db = createTestDb();
		recordConnection(db, { hostAlias: "100.72.63.61:8787", transport: "ws" });
		expect(resolveTransport(db, "100.72.63.61:8787", cfg)).toBe("ws");
		// An alias that later appears in ssh_config doesn't silently change wire.
		recordConnection(db, { hostAlias: "devbox", transport: "ssh" });
		expect(resolveTransport(db, "devbox", cfg)).toBe("ssh");
	});

	it("defaults pre-existing rows to ssh — every one predates the ws transport", () => {
		const db = createTestDb();
		recordConnection(db, { hostAlias: "old-box" }); // no transport given
		expect(repo.getHost(db, "old-box")?.transport).toBe("ssh");
		expect(listConnections(db, cfg).find((c) => c.alias === "old-box")?.transport).toBe("ssh");
	});

	it("surfaces a saved ws endpoint in the list, flagged as not in ssh_config", () => {
		const db = createTestDb();
		recordConnection(db, { hostAlias: "100.72.63.61:8787", transport: "ws", agentsAvailable: ["claude"] });
		const row = listConnections(db, cfg).find((c) => c.alias === "100.72.63.61:8787");
		expect(row).toMatchObject({ transport: "ws", inSshConfig: false, known: true });
		expect(listConnections(db, cfg).find((c) => c.alias === "devbox")?.transport).toBe("ssh");
	});
});
