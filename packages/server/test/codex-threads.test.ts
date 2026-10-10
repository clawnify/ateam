import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestCodexThreadInDir, type OpenSqlite } from "../src/codex-threads";

// Codex's thread index, as found on a machine running two tasks of one repo:
// `codex resume --last` in `ours` reopened `theirs` because it was newer. The
// reader must pick by exact cwd, and skip the reviewer/subagent threads Codex
// files under the same cwd.
const OURS = "/repo/.ateam/worktrees/ours";
const THEIRS = "/repo/.ateam/worktrees/theirs";

// better-sqlite3 does not load under Bun; bun:sqlite speaks the same slice.
const open: OpenSqlite = (path) => new Database(path, { readonly: true });

function codexHome(
	rows: Array<[id: string, cwd: string, source: string, updated: number, archived?: number]>,
) {
	const home = mkdtempSync(join(tmpdir(), "ateam-codex-"));
	const db = new Database(join(home, "state_5.sqlite"));
	db.exec(
		"create table threads (id text primary key, cwd text not null, source text not null, updated_at integer not null, archived integer not null default 0)",
	);
	const ins = db.prepare("insert into threads values (?, ?, ?, ?, ?)");
	for (const [id, cwd, source, updated, archived = 0] of rows)
		ins.run(id, cwd, source, updated, archived);
	db.close();
	return home;
}

const GUARDIAN = '{"subagent":{"other":"guardian"}}';

describe("latestCodexThreadInDir", () => {
	it("picks this worktree's newest thread over a sibling's newer one", () => {
		const home = codexHome([
			["mine-old", OURS, "cli", 100],
			["mine", OURS, "cli", 200],
			["theirs", THEIRS, "cli", 300],
		]);
		expect(latestCodexThreadInDir(OURS, { home, open })).toEqual({ ok: true, id: "mine" });
	});

	it("skips subagent and archived threads in the same cwd", () => {
		const home = codexHome([
			["mine", OURS, "cli", 100],
			["reviewer", OURS, GUARDIAN, 200],
			["gone", OURS, "cli", 300, 1],
		]);
		expect(latestCodexThreadInDir(OURS, { home, open })).toEqual({ ok: true, id: "mine" });
	});

	it("answers 'none here' when the index has nothing for this worktree", () => {
		const home = codexHome([["theirs", THEIRS, "cli", 300]]);
		expect(latestCodexThreadInDir(OURS, { home, open })).toEqual({ ok: true, id: null });
	});

	it("reads the highest-numbered index", () => {
		const home = codexHome([["mine", OURS, "cli", 100]]);
		writeFileSync(join(home, "state_4.sqlite"), "not a database");
		expect(latestCodexThreadInDir(OURS, { home, open })).toEqual({ ok: true, id: "mine" });
	});

	it("fails loudly, not 'none here', when there is no index or its schema moved", () => {
		const empty = mkdtempSync(join(tmpdir(), "ateam-codex-"));
		expect(latestCodexThreadInDir(OURS, { home: empty, open })).toEqual({ ok: false, id: null });
		const moved = mkdtempSync(join(tmpdir(), "ateam-codex-"));
		new Database(join(moved, "state_6.sqlite")).exec("create table sessions (id text)");
		expect(latestCodexThreadInDir(OURS, { home: moved, open })).toEqual({ ok: false, id: null });
	});
});
