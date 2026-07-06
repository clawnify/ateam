import { beforeEach, describe, expect, it } from "bun:test";
import { type AteamDb, repo } from "../src/index";
import { createTestDb } from "./helpers/test-db";

let db: AteamDb;
beforeEach(() => {
	db = createTestDb();
});

describe("hosts repo", () => {
	it("upserts, lists most-recently-seen first, gets, and deletes", () => {
		repo.upsertHost(db, {
			hostAlias: "box-a",
			serverVersion: "1.0.0",
			agentsAvailable: ["claude"],
			lastSeen: 100,
		});
		repo.upsertHost(db, { hostAlias: "box-b", lastSeen: 200 });

		expect(repo.listHosts(db).map((h) => h.hostAlias)).toEqual(["box-b", "box-a"]);
		expect(repo.getHost(db, "box-a")?.serverVersion).toBe("1.0.0");
		expect(repo.getHost(db, "box-a")?.agentsAvailable).toEqual(["claude"]);

		repo.deleteHost(db, "box-a");
		expect(repo.getHost(db, "box-a")).toBeUndefined();
		expect(repo.listHosts(db).map((h) => h.hostAlias)).toEqual(["box-b"]);
	});

	it("partial upsert updates only the given fields, preserving the rest", () => {
		repo.upsertHost(db, {
			hostAlias: "box",
			serverVersion: "2.0.0",
			agentsAvailable: ["claude", "codex"],
			lastSeen: 1,
		});
		repo.upsertHost(db, { hostAlias: "box", lastSeen: 999 }); // touch only

		const h = repo.getHost(db, "box");
		expect(h?.lastSeen).toBe(999);
		expect(h?.serverVersion).toBe("2.0.0");
		expect(h?.agentsAvailable).toEqual(["claude", "codex"]);
	});
});
