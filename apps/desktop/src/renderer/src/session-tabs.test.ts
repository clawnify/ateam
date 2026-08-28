import { expect, test } from "bun:test";
import type { AgentDTO, SessionDTO } from "@ateam/protocol";
import { activeTerminal, sessionTabs } from "./session-tabs";

const AGENTS: AgentDTO[] = [
	{ id: "claude", label: "Claude Code", description: "", available: true },
	{ id: "codex", label: "Codex", description: "", available: true },
];

function session(terminalId: string, agentId: string): SessionDTO {
	return {
		id: `s-${terminalId}`,
		taskId: "t1",
		agentId,
		terminalId,
		status: "idle",
		cwd: "/w",
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

test("a pick whose session ended falls to the newest survivor", () => {
	expect(activeTerminal([session("a", "claude"), session("b", "shell")], "gone")).toBe("b");
});

test("opening a task with sessions but no pick lands on the newest", () => {
	expect(activeTerminal([session("a", "claude"), session("b", "shell")], null)).toBe("b");
});

test("the last session ending leaves no terminal to show", () => {
	expect(activeTerminal([], "a")).toBeNull();
	expect(activeTerminal([], null)).toBeNull();
});
