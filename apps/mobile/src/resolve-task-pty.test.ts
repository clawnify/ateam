import { describe, expect, mock, test } from "bun:test";
import type { AteamApi, SessionDTO } from "@ateam/protocol";
import { resolveTaskPty } from "./resolve-task-pty";

const task = { id: "task", agentId: "claude" };
function session(terminalId: string, agentId = "claude"): SessionDTO {
	return {
		id: terminalId,
		taskId: task.id,
		terminalId,
		agentId,
		agentSessionId: "conversation",
		status: "idle",
		cwd: "/worktree",
	};
}
function setup(live: SessionDTO[] = [], saved: SessionDTO[] = []) {
	const pty = {
		listForTask: mock(async () => live),
		listRestorable: mock(async () => saved),
		restoreSession: mock(async () => ({ terminalId: "restored" })),
		spawnAgent: mock(async () => ({ terminalId: "agent" })),
		spawnShell: mock(async () => ({ terminalId: "shell" })),
	};
	return { api: { pty } as unknown as AteamApi, pty };
}

describe("mobile conversation selection", () => {
	test("reattaches to a coding agent even when a newer shell exists", async () => {
		const { api, pty } = setup([session("shell", "shell"), session("codex", "codex")]);
		expect(await resolveTaskPty(api, task, true)).toBe("codex");
		expect(pty.listRestorable).not.toHaveBeenCalled();
		expect(pty.spawnAgent).not.toHaveBeenCalled();
	});
	for (const fullScreen of [true, false]) {
		test(`restores the newest saved agent over a leftover shell (${fullScreen ? "full screen" : "tile"})`, async () => {
			const { api, pty } = setup(
				[session("shell", "shell")],
				[session("dead-shell", "shell"), session("dead-codex", "codex"), session("older")],
			);
			expect(await resolveTaskPty(api, task, fullScreen)).toBe("restored");
			expect(pty.restoreSession).toHaveBeenCalledWith({ taskId: "task", terminalId: "dead-codex" });
			expect(pty.spawnShell).not.toHaveBeenCalled();
			expect(pty.spawnAgent).not.toHaveBeenCalled();
		});
	}
	test("rechecks live sessions before launching", async () => {
		const { api, pty } = setup([], [session("dead")]);
		pty.listForTask.mockResolvedValueOnce([]).mockResolvedValueOnce([session("other-viewer")]);
		expect(await resolveTaskPty(api, task, true)).toBe("other-viewer");
		expect(pty.restoreSession).not.toHaveBeenCalled();
	});
	test("falls back to the task's agent resume when no restorable record exists", async () => {
		const { api, pty } = setup([session("old-mobile-shell", "shell")]);
		expect(await resolveTaskPty(api, task, true)).toBe("agent");
		expect(pty.spawnAgent).toHaveBeenCalledWith({
			taskId: "task",
			agentId: "claude",
			resume: true,
		});
	});
	test("a tile resumes a normally exited agent with no restorable tab", async () => {
		const { api, pty } = setup();
		expect(await resolveTaskPty(api, task, false)).toBe("agent");
		expect(pty.spawnAgent).toHaveBeenCalledWith({
			taskId: "task",
			agentId: "claude",
			resume: true,
		});
		expect(pty.spawnShell).not.toHaveBeenCalled();
	});

	test("paging an agentless tile does not launch anything", async () => {
		const { api, pty } = setup();
		expect(await resolveTaskPty(api, { ...task, agentId: null }, false)).toBeNull();
		expect(pty.spawnAgent).not.toHaveBeenCalled();
		expect(pty.spawnShell).not.toHaveBeenCalled();
	});
	test("an agentless task gets a shell only when explicitly opened", async () => {
		const { api, pty } = setup();
		expect(await resolveTaskPty(api, { ...task, agentId: null }, true)).toBe("shell");
		expect(pty.spawnAgent).not.toHaveBeenCalled();
	});
	test("does not launch after the user leaves during lookup", async () => {
		const { api, pty } = setup([], [session("dead")]);
		let cancelled = false;
		pty.listRestorable.mockImplementation(async () => {
			cancelled = true;
			return [session("dead")];
		});
		expect(await resolveTaskPty(api, task, true, () => cancelled)).toBeNull();
		expect(pty.restoreSession).not.toHaveBeenCalled();
	});
	test("expanding a restoring tile shares its pending launch", async () => {
		const { api, pty } = setup([], [session("dead")]);
		let finish!: (value: { terminalId: string }) => void;
		pty.restoreSession.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const tile = resolveTaskPty(api, task, false);
		const full = resolveTaskPty(api, task, true);
		// Drain the list/list/recheck continuations until both reach restore.
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(pty.restoreSession).toHaveBeenCalledTimes(1);
		finish({ terminalId: "shared" });
		expect(await Promise.all([tile, full])).toEqual(["shared", "shared"]);
	});
	test("a failed restore surfaces the error and remains retryable", async () => {
		const { api, pty } = setup([], [session("dead")]);
		pty.restoreSession.mockRejectedValueOnce(new Error("agent missing"));
		await expect(resolveTaskPty(api, task, true)).rejects.toThrow("agent missing");
		expect(pty.spawnShell).not.toHaveBeenCalled();
		expect(await resolveTaskPty(api, task, true)).toBe("restored");
	});
});
