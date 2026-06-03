import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "./schema";

/**
 * Common Drizzle handle type shared by the production driver (better-sqlite3,
 * used in the Electron/node runtime) and the test driver (bun:sqlite). Both are
 * synchronous SQLite drivers exposing the same query builder; we widen the
 * RunResult to `unknown` so the repo layer is driver-agnostic.
 */
export type GroveDb = BaseSQLiteDatabase<"sync", unknown, typeof schema>;

/** Minimal surface bootstrap needs — satisfied by both drivers' Database. */
export interface SqliteExecutor {
	exec(sql: string): unknown;
}
