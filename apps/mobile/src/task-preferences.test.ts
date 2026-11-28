import { expect, test } from "bun:test";
import { taskAgentOnBox, taskAgentOptions } from "./task-preferences";

const claude = { id: "claude", label: "Claude Code", description: "", available: true };
const codex = { id: "codex", label: "Codex", description: "", available: true };

test("switching boxes falls back to an installed agent and restores the preferred agent on return", () => {
	const preferred = codex.id;
	expect(taskAgentOptions([claude, codex], preferred).current).toBe(codex);
	expect(taskAgentOptions([claude, { ...codex, available: false }], preferred).current).toBe(
		claude,
	);
	expect(taskAgentOptions([claude, codex], preferred).current).toBe(codex);
});

test("a box with no catalog yet uses the saved agent or the first-run default", () => {
	expect(taskAgentOptions([], codex.id).current.id).toBe("codex");
	expect(taskAgentOptions([], null).current.id).toBe("claude");
	expect(taskAgentOptions([{ ...claude, available: false }, codex], null).current).toBe(codex);
});

test("launch rechecks a pick made before the box woke against the agents in its hello", () => {
	const pick = taskAgentOptions([], codex.id).current.id;
	expect(taskAgentOnBox(pick, [claude.id])).toBe(claude.id);
	expect(taskAgentOnBox(pick, [claude.id, codex.id])).toBe(codex.id);
	expect(taskAgentOnBox(pick, [])).toBe(codex.id);
});
