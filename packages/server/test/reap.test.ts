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
	it("never reclaims a session that has not reported an event yet", () => {
		const starting = session("a", { lastEventAt: null });
		expect(reapableSessions([starting], NOW, IDLE)).toEqual([]);
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
			session("starting", { lastEventAt: null }),
		];
		expect(reapableSessions(open, NOW, IDLE).map((s) => s.id)).toEqual(["due"]);
	});
});
