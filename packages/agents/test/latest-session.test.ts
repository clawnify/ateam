import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgent, latestSessionInDir } from "../src/registry";

// OpenCode counts every git worktree of a repo as ONE project and lists their
// conversations together, so `opencode --continue` in a task's worktree reaches
// whichever task in the repo ran last. This scan is what picks the id that
// actually belongs to the worktree in hand; these tests drive it with a stand-in
// for the login shell, so nothing here depends on opencode being installed.
const opencode = getAgent("opencode");
const claude = getAgent("claude");
if (!opencode || !claude) throw new Error("registry lost an agent");

// A real directory: the scan runs the CLI IN the worktree it asks about.
const HERE = mkdtempSync(join(tmpdir(), "ateam-worktree-"));
const THERE = join(HERE, "..", "theirs");

/** A `$SHELL -lc <cmd>` stand-in that prints `out` and exits with `code`. */
function fakeShell(out: string, code = 0): string {
	const dir = mkdtempSync(join(tmpdir(), "ateam-scan-"));
	const path = join(dir, "shell");
	writeFileSync(path, `#!/bin/sh\ncat <<'JSON'\n${out}\nJSON\nexit ${code}\n`);
	chmodSync(path, 0o755);
	return path;
}

const scan = (out: string, code = 0) => latestSessionInDir(opencode, HERE, fakeShell(out, code));

describe("latestSessionInDir", () => {
	it("takes the newest conversation in THIS directory, not the newest overall", async () => {
		const rows = [
			{ id: "ses_theirs", directory: THERE, updated: 300 },
			{ id: "ses_mine_old", directory: HERE, updated: 100 },
			{ id: "ses_mine", directory: HERE, updated: 200 },
		];
		expect(await scan(JSON.stringify(rows))).toEqual({ ok: true, id: "ses_mine" });
	});

	// "Asked, and this worktree has none" — the caller starts a fresh
	// conversation on it, which is the honest answer for a worktree nothing has
	// run in yet.
	it("answers `none` when only other directories have conversations", async () => {
		const rows = [{ id: "ses_theirs", directory: THERE, updated: 300 }];
		expect(await scan(JSON.stringify(rows))).toEqual({ ok: true, id: null });
	});

	it("answers `none` for an empty store", async () => {
		expect(await scan("")).toEqual({ ok: true, id: null });
	});

	// Not knowing must never read as "none": the caller falls back to the CLI's
	// own resume rather than silently abandoning the conversation.
	it("answers `unknown` when the CLI fails or its output moved", async () => {
		expect(await scan("", 1)).toEqual({ ok: false, id: null });
		expect(await scan("Session ID  Title  Updated")).toEqual({ ok: false, id: null });
		expect(await scan('{"sessions":[]}')).toEqual({ ok: false, id: null });
	});

	it("declines to guess for an agent that lists nothing", async () => {
		expect(await latestSessionInDir(claude, HERE, fakeShell("[]"))).toEqual({
			ok: false,
			id: null,
		});
	});
});
