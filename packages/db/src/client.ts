import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { bootstrap } from "./bootstrap";
import * as schema from "./schema";
import type { GroveDb } from "./types";

/**
 * Open (or create) the Grove SQLite database at `path` using better-sqlite3
 * (the Electron/node runtime driver). Tests use the bun:sqlite driver via a
 * separate helper; both share the schema and the driver-agnostic `GroveDb`.
 */
export function createDb(path: string): GroveDb {
	const sqlite = new Database(path);
	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("foreign_keys = ON");
	bootstrap(sqlite);
	return drizzle(sqlite, { schema }) as unknown as GroveDb;
}
