import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { type AteamDb, bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import {
	applySetWaiting,
	clearWaiting,
	expireWait,
	isFiredWait,
	MAX_WAIT_MS,
	validateWait,
	WaitTimers,
} from "../src/waits";

function createTestDb(): AteamDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	bootstrap(sqlite);
	return drizzle(sqlite, { schema }) as unknown as AteamDb;
}

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function makeTask(db: AteamDb, column: schema.KanbanColumn = "review", name = "a task") {
	const project =
		repo.listProjects(db)[0] ?? repo.upsertProject(db, { repoPath: "/tmp/repo", name: "repo" });
	return repo.createTask(db, {
		projectId: project.id,
		name,
		slug: name.replace(/ /g, "-"),
		branch: `feat/${name.replace(/ /g, "-")}`,
		baseBranch: "main",
		worktreePath: `/tmp/repo/.ateam/worktrees/${name.replace(/ /g, "-")}`,
		column,
	});
}

/** Fake timers: every scheduled callback is kept with its delay, fired by hand. */
function fakeClock(start = NOW) {
	let now = start;
	const pending: { fn: () => void; ms: number; id: number }[] = [];
	let seq = 0;
	return {
		now: () => now,
		advance(ms: number) {
			now += ms;
		},
		setTimeout: (fn: () => void, ms: number) => {
			const id = ++seq;
			pending.push({ fn, ms, id });
			return id;
		},
		clearTimeout: (h: unknown) => {
			const i = pending.findIndex((p) => p.id === h);
			if (i >= 0) pending.splice(i, 1);
		},
		/** Run every timer currently armed (not ones they arm in turn). */
		fireAll() {
			const batch = pending.splice(0);
			for (const p of batch) p.fn();
		},
		delays: () => pending.map((p) => p.ms),
	};
}

let db: AteamDb;
beforeEach(() => {
	db = createTestDb();
});

describe("validateWait", () => {
	it("needs a reason and a future date within a year", () => {
		expect(validateWait({ reason: "", until: NOW + DAY }, NOW).ok).toBe(false);
		expect(validateWait({ reason: "  ", until: NOW + DAY }, NOW).ok).toBe(false);
		expect(validateWait({ reason: "Twilio", until: NOW }, NOW).ok).toBe(false);
		expect(validateWait({ reason: "Twilio", until: "tomorrow" }, NOW).ok).toBe(false);
		expect(validateWait({ reason: "Twilio", until: NOW + MAX_WAIT_MS + 1 }, NOW).ok).toBe(false);
		expect(validateWait({ reason: "x".repeat(201), until: NOW + DAY }, NOW).ok).toBe(false);
		expect(validateWait({ reason: " Twilio ", until: NOW + DAY }, NOW)).toEqual({
			ok: true,
			reason: "Twilio",
			until: NOW + DAY,
		});
	});
});

describe("applySetWaiting", () => {
	it("parks the task, arms its timer and notifies", () => {
		const t = makeTask(db);
		const clock = fakeClock();
		const waits = new WaitTimers({ db, onExpired: () => {}, ...clock });
		const updated: string[] = [];
		const r = applySetWaiting(
			db,
			{ taskId: t.id, reason: "Twilio approval", until: NOW + 5 * DAY },
			waits,
			(id) => updated.push(id),
			NOW,
		);
		expect(r.ok).toBe(true);
		expect(r.reason).toContain("5d");
		expect(repo.getTask(db, t.id)).toMatchObject({
			waitingReason: "Twilio approval",
			waitingUntil: NOW + 5 * DAY,
			waitingFiredAt: null,
		});
		expect(waits.size).toBe(1);
		expect(updated).toEqual([t.id]);
	});

	it("re-setting a wait that already fired arms it again", () => {
		const t = makeTask(db);
		repo.updateTask(db, t.id, {
			waitingReason: "old",
			waitingUntil: NOW - DAY,
			waitingFiredAt: NOW - DAY,
		});
		const waits = new WaitTimers({ db, onExpired: () => {}, ...fakeClock() });
		const r = applySetWaiting(
			db,
			{ taskId: t.id, reason: "new", until: NOW + DAY },
			waits,
			() => {},
			NOW,
		);
		expect(r.ok).toBe(true);
		expect(repo.getTask(db, t.id)).toMatchObject({ waitingUntil: NOW + DAY, waitingFiredAt: null });
		expect(waits.nextDueAt()).toBe(NOW + DAY);
	});

	it("a session may only park its own task", () => {
		const mine = makeTask(db, "review", "mine");
		const theirs = makeTask(db, "review", "theirs");
		repo.createSession(db, {
			taskId: mine.id,
			agentId: "claude",
			terminalId: "term-mine",
			cwd: "/tmp",
		});
		const waits = new WaitTimers({ db, onExpired: () => {}, ...fakeClock() });
		const r = applySetWaiting(
			db,
			{ taskId: theirs.id, reason: "x", until: NOW + DAY, callerTerminalId: "term-mine" },
			waits,
			() => {},
			NOW,
		);
		expect(r.ok).toBe(false);
		expect(repo.getTask(db, theirs.id)?.waitingUntil).toBeNull();
		expect(waits.size).toBe(0);
	});

	it("a session that names no task parks its own; no session and no task is refused", () => {
		const mine = makeTask(db, "review", "mine");
		repo.createSession(db, {
			taskId: mine.id,
			agentId: "claude",
			terminalId: "term-x",
			cwd: "/tmp",
		});
		const waits = new WaitTimers({ db, onExpired: () => {}, ...fakeClock() });
		const r = applySetWaiting(
			db,
			{ reason: "Twilio", until: NOW + DAY, callerTerminalId: "term-x" },
			waits,
			() => {},
			NOW,
		);
		expect(r.ok).toBe(true);
		expect(repo.getTask(db, mine.id)?.waitingReason).toBe("Twilio");
		const none = applySetWaiting(db, { reason: "Twilio", until: NOW + DAY }, waits, () => {}, NOW);
		expect(none.ok).toBe(false);
	});

	it("refuses a bad wait without touching the row", () => {
		const t = makeTask(db);
		const waits = new WaitTimers({ db, onExpired: () => {}, ...fakeClock() });
		const r = applySetWaiting(
			db,
			{ taskId: t.id, reason: "", until: NOW + DAY },
			waits,
			() => {},
			NOW,
		);
		expect(r.ok).toBe(false);
		expect(repo.getTask(db, t.id)?.waitingUntil).toBeNull();
	});
});

describe("expireWait", () => {
	it("files a due card in Needs You, unread, stamps when, and leaves the reason on it", () => {
		const t = makeTask(db, "review");
		repo.updateTask(db, t.id, { waitingReason: "Twilio", waitingUntil: NOW - 1, isUnread: false });
		expect(expireWait(db, t.id, NOW)).toBe(true);
		expect(repo.getTask(db, t.id)).toMatchObject({
			column: "needs_attention",
			isUnread: true,
			waitingReason: "Twilio",
			waitingUntil: NOW - 1,
			waitingFiredAt: NOW,
		});
	});

	it("fires once: a wait that already resurfaced is not filed again", () => {
		const t = makeTask(db, "review");
		repo.updateTask(db, t.id, { waitingReason: "x", waitingUntil: NOW - 1 });
		expect(expireWait(db, t.id, NOW)).toBe(true);
		// The user reads it and drags the card back to Review.
		repo.updateTask(db, t.id, { column: "review", isUnread: false });
		expect(expireWait(db, t.id, NOW + DAY)).toBe(false);
		expect(repo.getTask(db, t.id)).toMatchObject({ column: "review", isUnread: false });
	});

	it("never moves a card an agent is live in, and ignores a cleared or future wait", () => {
		const live = makeTask(db, "running", "live");
		repo.updateTask(db, live.id, { waitingReason: "x", waitingUntil: NOW - 1 });
		expect(expireWait(db, live.id, NOW)).toBe(true);
		expect(repo.getTask(db, live.id)).toMatchObject({ column: "running", isUnread: true });

		const cleared = makeTask(db, "review", "cleared");
		expect(expireWait(db, cleared.id, NOW)).toBe(false);
		const future = makeTask(db, "review", "future");
		repo.updateTask(db, future.id, { waitingReason: "x", waitingUntil: NOW + DAY });
		expect(expireWait(db, future.id, NOW)).toBe(false);
		expect(repo.getTask(db, future.id)?.column).toBe("review");
	});
});

describe("clearWaiting", () => {
	it("ends a wait, fired or not, and reports whether there was one", () => {
		const t = makeTask(db);
		expect(clearWaiting(db, t)).toBe(false);
		repo.updateTask(db, t.id, { waitingReason: "x", waitingUntil: NOW + DAY });
		expect(clearWaiting(db, repo.getTask(db, t.id)!)).toBe(true);
		expect(repo.getTask(db, t.id)).toMatchObject({
			waitingReason: null,
			waitingUntil: null,
			waitingFiredAt: null,
		});
	});

	it("isFiredWait tells a resurfaced wait from a pending one", () => {
		expect(isFiredWait({ waitingFiredAt: null })).toBe(false);
		expect(isFiredWait({ waitingFiredAt: NOW })).toBe(true);
	});
});

describe("WaitTimers", () => {
	it("fires on the date and hands the task to onExpired", () => {
		const t = makeTask(db);
		repo.updateTask(db, t.id, { waitingReason: "x", waitingUntil: NOW + 2 * DAY });
		const clock = fakeClock();
		const expired: string[] = [];
		const waits = new WaitTimers({ db, onExpired: (id) => expired.push(id), ...clock });
		waits.arm(t.id, NOW + 2 * DAY);
		expect(clock.delays()).toEqual([2 * DAY]);
		clock.advance(2 * DAY);
		clock.fireAll();
		expect(expired).toEqual([t.id]);
		expect(repo.getTask(db, t.id)?.column).toBe("needs_attention");
		expect(waits.size).toBe(0);
	});

	it("a wait longer than setTimeout allows is armed in chunks and re-checked", () => {
		const t = makeTask(db);
		const until = NOW + 60 * DAY;
		repo.updateTask(db, t.id, { waitingReason: "x", waitingUntil: until });
		const clock = fakeClock();
		const expired: string[] = [];
		const waits = new WaitTimers({ db, onExpired: (id) => expired.push(id), ...clock });
		waits.arm(t.id, until);
		expect(clock.delays()).toEqual([2_147_483_647]);
		// Sixty days is three chunks: each fires, finds the row not yet due, and
		// re-arms for what is left, never trusting the original delay.
		let chunks = 0;
		while (clock.delays().length > 0 && clock.now() < until) {
			const [delay] = clock.delays();
			expect(delay).toBe(Math.min(until - clock.now(), 2_147_483_647));
			clock.advance(delay);
			clock.fireAll();
			chunks++;
		}
		expect(chunks).toBe(3);
		expect(expired).toEqual([t.id]);
	});

	it("a wait cleared or extended before the timer fires is honoured", () => {
		const a = makeTask(db, "review", "cleared");
		const b = makeTask(db, "review", "extended");
		const clock = fakeClock();
		const expired: string[] = [];
		const waits = new WaitTimers({ db, onExpired: (id) => expired.push(id), ...clock });
		repo.updateTask(db, a.id, { waitingReason: "x", waitingUntil: NOW + DAY });
		repo.updateTask(db, b.id, { waitingReason: "x", waitingUntil: NOW + DAY });
		waits.arm(a.id, NOW + DAY);
		waits.arm(b.id, NOW + DAY);
		repo.updateTask(db, a.id, { waitingReason: null, waitingUntil: null });
		repo.updateTask(db, b.id, { waitingUntil: NOW + 3 * DAY });
		clock.advance(DAY);
		clock.fireAll();
		expect(expired).toEqual([]);
		expect(repo.getTask(db, a.id)?.column).toBe("review");
		// b was re-armed for its new date.
		expect(clock.delays()).toEqual([2 * DAY]);
	});

	it("re-arming replaces the earlier timer instead of stacking", () => {
		const t = makeTask(db);
		const clock = fakeClock();
		const waits = new WaitTimers({ db, onExpired: () => {}, ...clock });
		waits.arm(t.id, NOW + DAY);
		waits.arm(t.id, NOW + 2 * DAY);
		expect(clock.delays()).toEqual([2 * DAY]);
		expect(waits.size).toBe(1);
	});

	it("start() re-arms every pending row; an overdue one fires at once", () => {
		const overdue = makeTask(db, "review", "overdue");
		const later = makeTask(db, "review", "later");
		makeTask(db, "review", "not waiting");
		repo.updateTask(db, overdue.id, { waitingReason: "x", waitingUntil: NOW - DAY });
		repo.updateTask(db, later.id, { waitingReason: "x", waitingUntil: NOW + DAY });
		const clock = fakeClock();
		const expired: string[] = [];
		const waits = new WaitTimers({ db, onExpired: (id) => expired.push(id), ...clock });
		waits.start();
		expect(waits.size).toBe(2);
		expect(clock.delays().sort()).toEqual([0, DAY].sort());
		clock.fireAll();
		expect(expired).toEqual([overdue.id]);
		expect(repo.getTask(db, overdue.id)?.column).toBe("needs_attention");
		expect(repo.getTask(db, later.id)?.column).toBe("review");
		waits.stop();
		expect(waits.size).toBe(0);
	});

	// The bug the port fixed: a fired wait keeps its date on the row, so a boot
	// that re-armed every row with a date re-filed it in Needs You, unread, on
	// every restart until the user replied.
	it("a restart does not re-fire a wait that already resurfaced", () => {
		const t = makeTask(db, "review");
		repo.updateTask(db, t.id, { waitingReason: "x", waitingUntil: NOW - DAY });
		const clock = fakeClock();
		const expired: string[] = [];
		const first = new WaitTimers({ db, onExpired: (id) => expired.push(id), ...clock });
		first.start();
		clock.fireAll();
		expect(expired).toEqual([t.id]);
		first.stop();

		repo.updateTask(db, t.id, { column: "review", isUnread: false });
		const second = new WaitTimers({ db, onExpired: (id) => expired.push(id), ...clock });
		second.start();
		expect(second.size).toBe(0);
		clock.fireAll();
		expect(expired).toEqual([t.id]);
		expect(repo.getTask(db, t.id)).toMatchObject({ column: "review", isUnread: false });
	});

	it("nextDueAt is the earliest pending wait, ignoring fired and cleared ones", () => {
		const waits = new WaitTimers({ db, onExpired: () => {}, ...fakeClock() });
		expect(waits.nextDueAt()).toBeNull();
		const soon = makeTask(db, "review", "soon");
		const later = makeTask(db, "review", "later");
		const fired = makeTask(db, "review", "fired");
		repo.updateTask(db, soon.id, { waitingReason: "x", waitingUntil: NOW + DAY });
		repo.updateTask(db, later.id, { waitingReason: "x", waitingUntil: NOW + 3 * DAY });
		repo.updateTask(db, fired.id, {
			waitingReason: "x",
			waitingUntil: NOW - DAY,
			waitingFiredAt: NOW - DAY,
		});
		expect(waits.nextDueAt()).toBe(NOW + DAY);
	});
});
