import { describe, expect, it } from "bun:test";
import { type ReapableSession, reapableSessions } from "../src/pty/reap";

const NOW = 1_000_000;
const IDLE = 2 * 60 * 60 * 1000;

function session(id: string, over: Partial<ReapableSession> = {}): ReapableSession {
	return {
		id,
		taskId: `task-${id}`,
		terminalId: `term-${id}`,
		agentId: "claude",
		status: "idle",
		lastEventAt: NOW - IDLE - 1,
		startedAt: NOW - IDLE - 60_000,
		lastInputAt: null,
		...over,
	};
}

describe("reapableSessions", () => {
	it("reclaims an agent that finished its turn and went quiet", () => {
		expect(reapableSessions([session("a")], NOW, IDLE).map((s) => s.id)).toEqual(["a"]);
	});

	it("leaves an agent that finished recently", () => {
		const fresh = session("a", { lastEventAt: NOW - IDLE + 1 });
		expect(reapableSessions([fresh], NOW, IDLE)).toEqual([]);
	});

	it("treats the threshold itself as due", () => {
		const exact = session("a", { lastEventAt: NOW - IDLE });
		expect(reapableSessions([exact], NOW, IDLE).map((s) => s.id)).toEqual(["a"]);
	});

	// The two endings that mean work is in flight. Killing either throws away
	// what the agent is mid-way through, which is what closing such a tab warns
	// about before it does anything.
	it("never reclaims a running agent, however long it has been quiet", () => {
		const busy = session("a", { status: "running", lastEventAt: 0 });
		expect(reapableSessions([busy], NOW, IDLE)).toEqual([]);
	});

	it("never reclaims an agent holding a question for the user", () => {
		const blocked = session("a", { status: "awaiting_input", lastEventAt: 0 });
		expect(reapableSessions([blocked], NOW, IDLE)).toEqual([]);
	});

	// Rows are born `idle` with no lastEventAt, BEFORE the agent starts. Without
	// this guard the first sweep after a launch would kill everything it found.
	it("never reclaims a session that just started and has not reported yet", () => {
		const starting = session("a", { lastEventAt: null, startedAt: NOW - 60_000 });
		expect(reapableSessions([starting], NOW, IDLE)).toEqual([]);
	});

	// A Codex resumed with no prompt reports nothing until it finishes a turn, so
	// one nobody types into (a tab a client restored on its own) has no event to
	// age by. On 2026-11-06 one such tab outlived its task's real agent by hours.
	it("reclaims one that never reported, counted from its launch", () => {
		const leftover = session("a", { agentId: "codex", lastEventAt: null, startedAt: NOW - IDLE });
		expect(reapableSessions([leftover], NOW, IDLE).map((s) => s.id)).toEqual(["a"]);
	});

	// OpenCode reports no events at all, and takes messages through its own
	// plugin with nobody typing: a long-ago launch says nothing about it.
	it("never reclaims an agent that reports no events, however old", () => {
		const opencode = session("a", { agentId: "opencode", lastEventAt: null, startedAt: 0 });
		expect(reapableSessions([opencode], NOW, IDLE)).toEqual([]);
	});

	it("leaves one with neither an event nor a launch time", () => {
		const unknown = session("a", { lastEventAt: null, startedAt: null });
		expect(reapableSessions([unknown], NOW, IDLE)).toEqual([]);
	});

	// Codex without its trusted hooks reports no turn start, so a prompt typed
	// into it leaves it `idle` while it works. Its last Stop being old enough
	// must not get that turn killed.
	it("never reclaims an agent typed into since it last reported", () => {
		const working = session("a", { agentId: "codex", lastInputAt: NOW - IDLE + 5_000 });
		expect(reapableSessions([working], NOW, IDLE)).toEqual([]);
		const typedAfterLaunch = session("b", {
			agentId: "codex",
			lastEventAt: null,
			startedAt: NOW - IDLE - 60_000,
			lastInputAt: NOW - IDLE - 30_000,
		});
		expect(reapableSessions([typedAfterLaunch], NOW, IDLE)).toEqual([]);
	});

	it("still reclaims one whose typing came before its last turn ended", () => {
		const answered = session("a", { lastInputAt: NOW - IDLE - 10_000 });
		expect(reapableSessions([answered], NOW, IDLE).map((s) => s.id)).toEqual(["a"]);
	});

	// A shell's state lives nowhere else and there is no transcript to resume.
	it("never reclaims a shell", () => {
		const shell = session("a", { agentId: "shell" });
		expect(reapableSessions([shell], NOW, IDLE)).toEqual([]);
	});

	it("separates due from live and in-flight in one pass", () => {
		const open = [
			session("due"),
			session("fresh", { lastEventAt: NOW - 60_000 }),
			session("busy", { status: "running" }),
			session("shell", { agentId: "shell" }),
			session("starting", { lastEventAt: null, startedAt: NOW - 60_000 }),
		];
		expect(reapableSessions(open, NOW, IDLE).map((s) => s.id)).toEqual(["due"]);
	});
});
