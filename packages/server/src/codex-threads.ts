// "The newest Codex conversation in THIS worktree", read from Codex's own
// thread index (~/.codex/state_<N>.sqlite, table `threads`).
//
// `codex resume --last` is not scoped to the cwd the way Claude's `--continue`
// is: launched in one task's worktree it reopened a sibling worktree's newer
// thread (Codex then asks which directory to use, offering the sibling's first).
// Every task is a worktree of a repo with many, so the newest thread "here" by
// Codex's reckoning is very often another task's. The index records each
// thread's exact cwd, so the id that belongs to this worktree can be picked
// here and resumed by name.
//
// The store, not the CLI, because Codex has no command that lists threads (the
// rule `latestSessionInDir` follows for OpenCode). That makes the failure mode
// the thing to get right: a store we cannot open or query answers `ok: false`,
// which the caller degrades to `codex resume --last`, today's behaviour, never
// to "no conversation here". The rollout JSONL files are not the source either:
// Codex is migrating them into paginated thread history (`codex
// migrate-rollouts`), and this index is what it keeps for both.
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SessionScan } from "@ateam/agents";

/** The slice of better-sqlite3 this reader uses, typed locally so the module
 *  never imports the native driver at load time (same as the OpenCode source). */
export interface SqliteHandle {
	prepare(sql: string): { get(...params: unknown[]): unknown };
	close(): void;
}
export type OpenSqlite = (path: string) => SqliteHandle;

const openWithDriver: OpenSqlite = (path) => {
	type Ctor = new (p: string, o: { readonly: boolean; fileMustExist: boolean }) => SqliteHandle;
	const Database = createRequire(import.meta.url)("better-sqlite3") as Ctor;
	return new Database(path, { readonly: true, fileMustExist: true });
};

const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");

/** The current index: Codex bumps the number on a breaking schema change. */
function stateDbPath(home: string): string | null {
	let best: { n: number; name: string } | null = null;
	try {
		for (const name of readdirSync(home)) {
			const m = /^state_(\d+)\.sqlite$/.exec(name);
			if (m && (!best || Number(m[1]) > best.n)) best = { n: Number(m[1]), name };
		}
	} catch {
		return null;
	}
	return best ? join(home, best.name) : null;
}

/**
 * Only threads a person had: `cli` (the TUI) and `vscode` (the extension).
 * Codex files its Guardian reviewer and spawned subagents in the same table,
 * under the same cwd, as JSON sources, and they are newer than the turn that
 * spawned them, so without this the "newest" thread is a reviewer's.
 */
const NEWEST_IN_DIR = `select id from threads
	where cwd = ? and archived = 0 and source in ('cli', 'vscode')
	order by updated_at desc, id desc limit 1`;

export function latestCodexThreadInDir(
	cwd: string,
	opts: { home?: string; open?: OpenSqlite } = {},
): SessionScan {
	const path = stateDbPath(opts.home ?? codexHome());
	if (!path) return { ok: false, id: null };
	let db: SqliteHandle;
	try {
		db = (opts.open ?? openWithDriver)(path);
	} catch {
		return { ok: false, id: null };
	}
	try {
		const row = db.prepare(NEWEST_IN_DIR).get(resolve(cwd)) as { id?: unknown } | undefined;
		return { ok: true, id: typeof row?.id === "string" ? row.id : null };
	} catch {
		// A column or table that moved is the schema changing under us: say so,
		// rather than "nothing here", which would start a fresh conversation.
		return { ok: false, id: null };
	} finally {
		db.close();
	}
}
