import { expect, test } from "bun:test";
import type { AgentDTO, SessionDTO } from "@ateam/protocol";
import {
	activeTerminal,
	conversationToResume,
	sessionTabs,
	taskGlyphs,
	tileSessions,
} from "./session-tabs";

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

test("a task's glyphs are its live sessions, falling back to the last agent launched", () => {
	expect(taskGlyphs({ agentId: "claude", agentIds: ["claude", "shell", "claude"] })).toEqual([
		"claude",
		"shell",
		"claude",
	]);
	// Nothing live: the task still reads as the agent that last ran here.
	expect(taskGlyphs({ agentId: "claude", agentIds: [] })).toEqual(["claude"]);
	// An engine too old to send the field reads the same as nothing live.
	expect(taskGlyphs({ agentId: "codex" })).toEqual(["codex"]);
	expect(taskGlyphs({ agentId: null })).toEqual([]);
});

// --- an agent asleep behind a shell -----------------------------------------
// The reaper takes idle agents and never shells, so the shell a task had open
// beside its agent outlives it.

test("opening a task whose agent sleeps beside a live shell brings the agent back", () => {
	const live = [session("sh", "shell")];
	const reaped = session("c", "claude");
	expect(conversationToResume(live, [reaped], null)).toBe(reaped);
});

test("a shell you are on is never swapped away when the agent beside it goes to sleep", () => {
	const live = [session("sh", "shell")];
	expect(conversationToResume(live, [session("c", "claude")], "sh")).toBeNull();
});

test("the agent you were looking at going to sleep brings that one back, not a newer one", () => {
	const yours = session("c1", "claude");
	const live = [session("sh", "shell")];
	expect(conversationToResume(live, [yours, session("c2", "claude")], "c1")).toBe(yours);
	// With nothing live at all, the same.
	expect(conversationToResume([], [yours, session("c2", "claude")], "c1")).toBe(yours);
});

test("closing an agent on purpose beside a shell does not revive an older conversation", () => {
	// The closed tab is neither live nor restorable; an older reaped one is.
	const live = [session("sh", "shell")];
	expect(conversationToResume(live, [session("old", "claude")], "closed")).toBeNull();
});

test("a live agent settles it, whatever else is restorable", () => {
	const live = [session("a", "claude"), session("sh", "shell")];
	expect(conversationToResume(live, [session("old", "claude")], null)).toBeNull();
});

test("a quit agent still on its pane counts as live, so nothing is relaunched behind it", () => {
	const quit = { ...session("a", "claude"), status: "stopped" as const };
	expect(conversationToResume([quit], [session("old", "claude")], null)).toBeNull();
});

test("shells alone with nothing asleep start nothing: no --continue behind a shell", () => {
	expect(conversationToResume([session("sh", "shell")], [], null)).toBeNull();
	// A restorable shell is not a conversation.
	expect(
		conversationToResume([session("sh", "shell")], [session("old", "shell")], null),
	).toBeNull();
});

test("the newest sleeping agent wins, skipping restorable shells", () => {
	const older = session("c1", "claude");
	const newer = session("c2", "codex");
	expect(conversationToResume([], [older, newer, session("s", "shell")], null)).toBe(newer);
	// A closed tab you were on changes nothing when nothing is live.
	expect(conversationToResume([], [older, newer], "closed")).toBe(newer);
});

test("a task with nothing at all left resumes the latest conversation", () => {
	expect(conversationToResume([], [], null)).toBe("latest");
	expect(conversationToResume([], [session("s", "shell")], "s")).toBe("latest");
});

test("a task with an agent live is a tile, its shells riding along as tabs", () => {
	const sessions = [session("sh", "shell"), session("a", "claude")];
	expect(tileSessions(sessions)).toEqual(sessions);
});

test("a task left with only a shell is not a tile", () => {
	expect(tileSessions([session("sh", "shell")])).toEqual([]);
});

test("a quit agent gets no tab, and leaves no tile when shells are all that remain", () => {
	const quit = { ...session("a", "claude"), status: "stopped" as const };
	expect(tileSessions([quit, session("sh", "shell")])).toEqual([]);
	const live = session("b", "codex");
	expect(tileSessions([quit, live])).toEqual([live]);
});
