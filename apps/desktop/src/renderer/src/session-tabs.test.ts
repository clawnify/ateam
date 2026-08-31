import { expect, test } from "bun:test";
import type { AgentDTO, SessionDTO } from "@ateam/protocol";
import { activeTerminal, sessionTabs } from "./session-tabs";

const AGENTS: AgentDTO[] = [
	{ id: "claude", label: "Claude Code", description: "", available: true },
	{ id: "codex", label: "Codex", description: "", available: true },
];

function session(terminalId: string, agentId: string, lastEventAt?: number): SessionDTO {
	return {
		id: `s-${terminalId}`,
		taskId: "t1",
		agentId,
		terminalId,
		agentSessionId: agentId === "shell" ? null : terminalId,
		status: "idle",
		cwd: "/w",
		lastEventAt: lastEventAt ?? null,
	};
}

test("a single session of a kind is labelled by name alone", () => {
	const tabs = sessionTabs([session("a", "claude"), session("b", "shell")], AGENTS);
	expect(tabs.map((t) => t.label)).toEqual(["Claude Code", "Shell"]);
});

test("repeats of the same agent are numbered from the second, oldest keeping its name", () => {
	const tabs = sessionTabs(
		[session("a", "claude"), session("b", "shell"), session("c", "claude"), session("d", "shell")],
		AGENTS,
	);
	expect(tabs.map((t) => t.label)).toEqual(["Claude Code", "Shell", "Claude Code 2", "Shell 2"]);
});

test("an agent the engine no longer reports falls back to its id", () => {
	expect(sessionTabs([session("a", "gemini")], AGENTS)[0].label).toBe("gemini");
});

test("a live pick is kept even when it is not the newest", () => {
	const live = [session("a", "claude"), session("b", "shell")];
	expect(activeTerminal(live, "a")).toBe("a");
});

test("a pick whose session ended falls to the newest surviving agent", () => {
	expect(activeTerminal([session("a", "shell"), session("b", "claude")], "gone")).toBe("b");
});

test("opening a task with no pick lands on the newest agent, not a newer shell", () => {
	const live = [session("a", "claude"), session("b", "shell")];
	expect(activeTerminal(live, null)).toBe("a");
});

test("the newest agent wins even with shells opened on either side of it", () => {
	const live = [
		session("a", "shell"),
		session("b", "claude"),
		session("c", "codex"),
		session("d", "shell"),
	];
	expect(activeTerminal(live, null)).toBe("c");
});

test("a task with only shells still shows its newest one", () => {
	expect(activeTerminal([session("a", "shell"), session("b", "shell")], null)).toBe("b");
});

test("an explicit pick of a shell is kept even though an agent is running", () => {
	const live = [session("a", "claude"), session("b", "shell")];
	expect(activeTerminal(live, "b")).toBe("b");
});

test("with no pick, the agent that most recently did something wins over the newest", () => {
	const live = [session("a", "claude", 200), session("b", "codex", 100)];
	expect(activeTerminal(live, null)).toBe("a");
});

test("a busy shell never steals the tab from the agent that reported longest ago", () => {
	const live = [session("a", "claude", 100), session("b", "shell", 999)];
	expect(activeTerminal(live, null)).toBe("a");
});

test("an engine too old to report activity still lands on the newest agent", () => {
	const live = [session("a", "claude"), session("b", "codex")];
	expect(activeTerminal(live, null)).toBe("b");
});

test("a session that has never reported loses to one that has", () => {
	const live = [session("a", "claude", 50), session("b", "codex")];
	expect(activeTerminal(live, null)).toBe("a");
});

test("the last session ending leaves no terminal to show", () => {
	expect(activeTerminal([], "a")).toBeNull();
	expect(activeTerminal([], null)).toBeNull();
});

// --- tabs a restart took away -------------------------------------------------

test("a task with nothing stranded has the strip it always had", () => {
	const tabs = sessionTabs([session("a", "claude")], AGENTS, []);
	expect(tabs.map((t) => [t.label, t.live])).toEqual([["Claude Code", true]]);
});

test("stranded tabs follow the live ones and are marked not live", () => {
	const tabs = sessionTabs([session("a", "claude")], AGENTS, [session("b", "claude")]);
	expect(tabs.map((t) => [t.label, t.live])).toEqual([
		["Claude Code", true],
		["Claude Code 2", false],
	]);
});

// The whole reason the feature exists: a task can strand several tabs at once,
// and each has to come back as its own.
test("several stranded sessions each get their own numbered tab", () => {
	const tabs = sessionTabs([], AGENTS, [
		session("a", "claude"),
		session("b", "claude"),
		session("c", "shell"),
	]);
	expect(tabs.map((t) => t.label)).toEqual(["Claude Code", "Claude Code 2", "Shell"]);
	expect(tabs.every((t) => !t.live)).toBe(true);
});

// A stranded tab holds no terminal, so it must never be what the panel shows.
test("a stranded session is not something the view can land on", () => {
	expect(activeTerminal([], null)).toBeNull();
});
