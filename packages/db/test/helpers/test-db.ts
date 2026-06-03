import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { bootstrap } from "../../src/bootstrap";
import * as schema from "../../src/schema";
import type { GroveDb } from "../../src/types";

/**
 * In-memory test database using the bun:sqlite driver (better-sqlite3 can't
 * load under Bun). Same schema + same driver-agnostic GroveDb type as prod.
 */
export function createTestDb(): GroveDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	bootstrap(sqlite);
	return drizzle(sqlite, { schema }) as unknown as GroveDb;
}
