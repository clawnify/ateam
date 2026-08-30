import { describe, expect, it } from "bun:test";
import { type OpenSession, strandedSessions } from "../src/pty/stranded";

const ENGINE_START = 10_000;

function session(id: string, startedAt: number | null): OpenSession {
	return { id, taskId: `task-${id}`, terminalId: `term-${id}`, startedAt };
}

describe("strandedSessions", () => {
	it("closes an old session the daemon no longer knows about", () => {
		const open = [session("a", ENGINE_START - 1000)];
		expect(strandedSessions(open, new Set(), ENGINE_START).map((s) => s.id)).toEqual(["a"]);
	});

	it("leaves a session the daemon still reports alive", () => {
		const open = [session("a", ENGINE_START - 1000)];
		expect(strandedSessions(open, new Set(["term-a"]), ENGINE_START)).toEqual([]);
	});

	// The race this guard exists for: a session row is written before its spawn
	// reaches the daemon, so a respawned daemon's first `hello` omits terminals
	// that are about to start. Those belong to the live exit path, not here.
	it("leaves a session started after the engine, even when absent from the live set", () => {
		const open = [session("new", ENGINE_START + 5)];
		expect(strandedSessions(open, new Set(), ENGINE_START)).toEqual([]);
	});

	it("treats a session started exactly at engine start as current", () => {
		const open = [session("boundary", ENGINE_START)];
		expect(strandedSessions(open, new Set(), ENGINE_START)).toEqual([]);
	});

	it("treats a null startedAt as ancient, so a legacy row is never left stranded", () => {
		const open = [session("legacy", null)];
		expect(strandedSessions(open, new Set(), ENGINE_START).map((s) => s.id)).toEqual(["legacy"]);
	});

	it("separates stranded from live and current in one pass", () => {
		const open = [
			session("dead", ENGINE_START - 5000),
			session("alive", ENGINE_START - 5000),
			session("fresh", ENGINE_START + 50),
		];
		expect(strandedSessions(open, new Set(["term-alive"]), ENGINE_START).map((s) => s.id)).toEqual([
			"dead",
		]);
	});
});
