import { beforeEach, describe, expect, it } from "bun:test";
import { type AteamDb, repo } from "@ateam/db";
import { createTestDb } from "../../db/test/helpers/test-db";
import { makeStrandReconciler } from "../src/pty/reconcile";

// The reboot path, against a real db: the machine goes down, the PTY daemon
// goes with it, and on the next connect the engine has to work out which tabs
// were open at that moment — that set, and only it, is what the panel offers
// back. Driven directly rather than through createEngine, which needs a live
// daemon and a socket.
let db: AteamDb;
let taskId: string;

beforeEach(() => {
	db = createTestDb();
	const project = repo.upsertProject(db, { repoPath: "/r", name: "R" });
	taskId = repo.createTask(db, {
		projectId: project!.id,
		name: "t",
		slug: "t",
		branch: "t",
		baseBranch: "main",
		worktreePath: "/wt/t",
	}).id;
});

/** An open session that started before this engine run. */
function openSession(terminalId: string, startedAt = 1_000) {
	const s = repo.createSession(db, {
		taskId,
		agentId: "claude",
		terminalId,
		agentSessionId: terminalId,
		cwd: "/wt/t",
	});
	repo.updateSession(db, s.id, { startedAt });
	return s;
}

/** The engine's own applyExit, reduced to what these assertions need. */
const closeOut =
	(db: AteamDb) =>
	(s: { id: string }): void => {
		repo.updateSession(db, s.id, { status: "stopped", exitedAt: 2_000, exitReason: "stranded" });
	};

describe("makeStrandReconciler", () => {
	// The bug the user hit: two agent tabs open, restart the laptop, and only
	// one came back. Both were open, so both must be offered.
	it("offers back every tab that was open when the daemon went away", () => {
		openSession("term-1");
		openSession("term-2");

		const reconcile = makeStrandReconciler(db, 1_500, closeOut(db));
		const stranded = reconcile(new Set());

		expect(stranded.map((s) => s.terminalId).sort()).toEqual(["term-1", "term-2"]);
		expect(
			repo
				.listRestorableSessions(db, taskId)
				.map((s) => s.terminalId)
				.sort(),
		).toEqual(["term-1", "term-2"]);
	});

	it("leaves alone a session the daemon still holds", () => {
		openSession("term-live");
		const reconcile = makeStrandReconciler(db, 1_500, closeOut(db));

		expect(reconcile(new Set(["term-live"]))).toEqual([]);
		expect(repo.listRestorableSessions(db, taskId)).toEqual([]);
	});

	// A session row is written just BEFORE its spawn reaches the daemon, so the
	// daemon's first hello legitimately omits terminals that are about to start.
	it("leaves alone a session younger than this engine run", () => {
		openSession("term-new", 9_999);
		const reconcile = makeStrandReconciler(db, 1_500, closeOut(db));

		expect(reconcile(new Set())).toEqual([]);
		expect(repo.listRestorableSessions(db, taskId)).toEqual([]);
	});

	// Otherwise each run of the app leaves its own layer of ghosts on the strip.
	it("retires the previous run's offer, then makes this run's", () => {
		const old = openSession("term-old");
		repo.updateSession(db, old.id, { exitedAt: 1, exitReason: "stranded" });
		openSession("term-now");

		const stranded = makeStrandReconciler(db, 1_500, closeOut(db))(new Set());

		expect(stranded.map((s) => s.terminalId)).toEqual(["term-now"]);
		expect(repo.listRestorableSessions(db, taskId).map((s) => s.terminalId)).toEqual(["term-now"]);
		expect(repo.getSessionByTerminal(db, "term-old")?.exitReason).toBe("exited");
	});

	// A reconnect mid-run must not throw away tabs this run has not yet had the
	// chance to restore — the daemon can drop and come back at any time.
	it("does not retire this run's own offer on a reconnect", () => {
		openSession("term-1");
		const reconcile = makeStrandReconciler(db, 1_500, closeOut(db));

		reconcile(new Set());
		reconcile(new Set()); // the daemon reconnected

		expect(repo.listRestorableSessions(db, taskId).map((s) => s.terminalId)).toEqual(["term-1"]);
	});
});
