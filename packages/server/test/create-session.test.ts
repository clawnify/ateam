import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repo } from "@ateam/db";
import { TASK_REMOVING_ERROR } from "@ateam/protocol";
import { createTestDb } from "../../db/test/helpers/test-db";
import { peerToken } from "../src/agent-setup";
import { FollowUps } from "../src/follow-ups";
import type { SpawnOptions } from "../src/pty/pty-client";
import type { Services } from "../src/services";
import { createSessionInCallerTask, MAX_MCP_SESSIONS } from "../src/sessions";
import { WorktreeGuard } from "../src/worktree-guard";

let services: Services;
let taskId: string;
let scratch: string;
let spawned: SpawnOptions[];
let live: Set<string>;
let updated: string[];
const callerTerminalId = "caller";
const notify = (id: string) => updated.push(id);
const create = (agent = "shell", prompt?: string) =>
	createSessionInCallerTask(services, notify, { callerTerminalId, agent, prompt });

beforeEach(() => {
	const db = createTestDb();
	scratch = mkdtempSync(join(tmpdir(), "ateam-create-session-"));
	spawned = [];
	live = new Set([callerTerminalId]);
	updated = [];
	services = {
		db,
		pty: {
			has: (id: string) => live.has(id),
			spawn: (o: SpawnOptions) => {
				spawned.push(o);
				live.add(o.terminalId);
				return o.terminalId;
			},
		},
		hooksDir: scratch,
		notifyScriptPath: join(scratch, "notify.sh"),
		peerSecret: "test-secret",
		hookPort: 12345,
		followUps: new FollowUps(),
		pendingSeeds: new Map(),
		worktreeGuard: new WorktreeGuard(),
		probeAgent: async () => "present",
		refreshPath: async () => false,
	} as unknown as Services;
	const project = repo.upsertProject(db, {
		repoPath: scratch,
		name: "Repo",
		defaultBranch: "main",
	});
	const task = repo.createTask(db, {
		projectId: project!.id,
		name: "existing task",
		slug: "existing-task",
		branch: "existing-task",
		baseBranch: "main",
		worktreePath: scratch,
	});
	taskId = task.id;
	repo.updateTask(db, taskId, { description: "original task instructions", tags: ["test"] });
	repo.createSession(db, { taskId, terminalId: callerTerminalId, agentId: "codex", cwd: scratch });
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("createSessionInCallerTask", () => {
	it("opens a shell in the caller's worktree and broadcasts it without altering task metadata", async () => {
		const before = repo.getTask(services.db, taskId);
		const opened = await create();
		expect(opened).toMatchObject({ taskId, agent: "shell" });
		expect(opened.terminalId).not.toBe(callerTerminalId);
		expect(spawned[0]).toMatchObject({ terminalId: opened.terminalId, cwd: scratch, args: ["-l"] });
		expect(repo.getSessionByTerminal(services.db, opened.terminalId)).toMatchObject({
			taskId,
			cwd: scratch,
			agentId: "shell",
		});
		expect(repo.getTask(services.db, taskId)).toEqual(before);
		expect(updated).toEqual([taskId]);
		expect(live.has(callerTerminalId)).toBe(true);
	});

	for (const agent of ["claude", "codex", "opencode"]) {
		it(`starts a fresh ${agent} conversation with its prompt and own MCP identity`, async () => {
			const opened = await create(agent, "review this task's diff");
			const launch = spawned[0]!;
			expect(launch.cwd).toBe(scratch);
			expect(launch.env.ATEAM_TERMINAL_ID).toBe(opened.terminalId);
			expect(launch.env.ATEAM_TERMINAL_TOKEN).toBe(peerToken("test-secret", opened.terminalId));
			const command = launch.args[2]!;
			expect(command).toContain("review this task");
			expect(command).not.toContain("--continue");
			expect(command).not.toContain("--resume");
			expect(command).not.toContain("--dangerously-bypass");
			expect(command).not.toContain("--permission-mode auto");
			if (agent === "claude") {
				expect(command).toContain("--mcp-config");
				expect(command).toContain("mcp__ateam_board__create_session");
			} else if (agent === "codex") {
				expect(command).toContain("mcp_servers.ateam_board.tools.create_session.approval_mode");
			} else {
				expect(JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!).mcp.ateam_board).toBeTruthy();
			}
			expect(repo.getSessionByTerminal(services.db, opened.terminalId)).toMatchObject({
				taskId,
				agentId: agent,
				status: "running",
			});
			expect(repo.getTask(services.db, taskId)?.description).toBe("original task instructions");
			expect(updated).toContain(taskId);
		});
	}

	it("keeps an empty agent session idle", async () => {
		const opened = await create("codex");
		expect(repo.getSessionByTerminal(services.db, opened.terminalId)?.status).toBe("idle");
	});

	it("refuses unknown, dead, stopped and plain-shell callers without starting anything", async () => {
		await expect(
			createSessionInCallerTask(services, notify, {
				callerTerminalId: "unknown",
				agent: "shell",
			}),
		).rejects.toThrow("only a live agent");
		const caller = repo.getSessionByTerminal(services.db, callerTerminalId)!;
		live.delete(callerTerminalId);
		await expect(create()).rejects.toThrow("only a live agent");
		live.add(callerTerminalId);
		for (const patch of [
			{ exitedAt: Date.now() },
			{ exitedAt: null, status: "stopped" as const },
			{ status: "idle" as const, agentId: "shell" },
		]) {
			repo.updateSession(services.db, caller.id, patch);
			await expect(create()).rejects.toThrow("only a live agent");
		}
		expect(spawned).toHaveLength(0);
		expect(updated).toHaveLength(0);
	});

	it("refuses archived tasks and a worktree being removed", async () => {
		repo.updateTask(services.db, taskId, { archivedAt: Date.now() });
		await expect(create()).rejects.toThrow("archived");
		repo.updateTask(services.db, taskId, { archivedAt: null });
		await services.worktreeGuard.remove(taskId, undefined, async () => {
			await expect(create()).rejects.toThrow(TASK_REMOVING_ERROR);
			await expect(create("codex")).rejects.toThrow(TASK_REMOVING_ERROR);
		});
		expect(spawned).toHaveLength(0);
	});

	it("bounds concurrent calls while their CLI probes are still pending", async () => {
		let release!: () => void;
		const probe = new Promise<void>((resolve) => {
			release = resolve;
		});
		services.probeAgent = async () => {
			await probe;
			return "present";
		};
		const pending = Array.from({ length: MAX_MCP_SESSIONS - 1 }, () => create("codex"));
		await expect(create()).rejects.toThrow("session limit");
		release();
		await Promise.all(pending);
		expect(spawned).toHaveLength(MAX_MCP_SESSIONS - 1);
		await expect(create()).rejects.toThrow("session limit");
		// Closing every new tab does not allow rapid create/close loops.
		for (const s of spawned) live.delete(s.terminalId);
		await expect(create()).rejects.toThrow("session limit");
	});

	it("a missing agent leaves no row or launch reservation, so the next call can succeed", async () => {
		services.probeAgent = async () => "absent";
		await expect(create("codex")).rejects.toThrow("not on PATH");
		expect(repo.listSessionsByTask(services.db, taskId)).toHaveLength(1);
		await create();
		expect(spawned).toHaveLength(1);
	});
});
