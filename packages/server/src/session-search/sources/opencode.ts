// OpenCode's transcript store: a SQLite database at
// ~/.local/share/opencode/opencode.db, not files on disk. `session.directory`
// is the cwd, and a message's text lives in the `part` rows that hang off it.
//
// Opened read-only, and every failure is swallowed into "no history": another
// tool's database is not ours to repair, and a locked or moved store must not
// take the search down for the other harnesses.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pushPrompt } from "../digest";
import type { SessionDigest, TranscriptSource } from "../types";

const DB_PATH = () => join(homedir(), ".local", "share", "opencode", "opencode.db");

/** The slice of better-sqlite3 this source uses, typed locally so the module
 *  never imports the native driver at load time. */
interface SqliteHandle {
	prepare(sql: string): { all(...params: unknown[]): unknown[] };
	close(): void;
}
type SqliteCtor = new (
	path: string,
	opts: { readonly: boolean; fileMustExist: boolean },
) => SqliteHandle;

interface SessionRow {
	id: string;
	directory: string;
	title: string | null;
	time_created: number | null;
	time_updated: number | null;
}

export function opencodeSource(): TranscriptSource {
	return {
		agentId: "opencode",
		digestsFor(cwds) {
			const path = DB_PATH();
			if (!existsSync(path) || cwds.length === 0) return [];
			// Required lazily: the driver is a native module that loads under
			// node (Electron, the box daemon) but not under Bun, where the tests
			// run. A driver that will not load is simply one harness we cannot
			// read, never a broken search.
			let db: SqliteHandle;
			try {
				const Database = createRequire(import.meta.url)("better-sqlite3") as SqliteCtor;
				db = new Database(path, { readonly: true, fileMustExist: true });
			} catch {
				return [];
			}
			try {
				const placeholders = cwds.map(() => "?").join(",");
				const sessions = db
					.prepare(
						`select id, directory, title, time_created, time_updated
						 from session where directory in (${placeholders})`,
					)
					.all(...cwds) as SessionRow[];
				const parts = db.prepare(
					`select p.data as data from part p
					 join message m on m.id = p.message_id
					 where p.session_id = ? and json_extract(m.data, '$.role') = 'user'
					 order by p.time_created`,
				);
				const out: SessionDigest[] = [];
				for (const s of sessions) {
					const prompts: string[] = [];
					// The session title is the user's own words too, and it is the one
					// line OpenCode itself shows for a session — worth searching.
					if (s.title) pushPrompt(prompts, s.title);
					for (const row of parts.all(s.id) as { data: string }[]) {
						let part: { type?: string; text?: string };
						try {
							part = JSON.parse(row.data);
						} catch {
							continue;
						}
						if (part.type === "text" && part.text) pushPrompt(prompts, part.text);
					}
					if (prompts.length === 0) continue;
					out.push({
						agentId: "opencode",
						sessionId: s.id,
						cwd: s.directory,
						branch: null,
						startedAt: s.time_created ?? null,
						endedAt: s.time_updated ?? null,
						prompts,
						path,
						// The store is one file for every session, so its mtime would
						// invalidate everything on any activity — the session's own
						// updated stamp is the honest per-session cache key.
						mtimeMs: s.time_updated ?? 0,
					});
				}
				return out;
			} catch {
				return [];
			} finally {
				db.close();
			}
		},
	};
}
