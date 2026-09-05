import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BinaryPresence } from "@ateam/agents";
import type { AteamDb } from "@ateam/db";
import { bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import { FollowUps } from "../src/follow-ups";
import type { Services } from "../src/services";
import { spawnAgentInTask } from "../src/sessions";

// An agent CLI can be there on Monday and gone on Tuesday — uninstalled, or a
// PATH that moved under a reboot. The launch line is `<agent>; exec $SHELL -l`,
// so without a check the missing binary produces one line of shell output in a
// pane that then looks perfectly healthy, while the card is filed `running` and
// a loop tick reports "run 1 started". Every launch therefore asks first.

function createTestDb(): AteamDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	bootstrap(sqlite);
	return drizzle(sqlite, { schema }) as unknown as AteamDb;
}

let db: AteamDb;
let taskId: string;
let spawned: number;
let scratch: string;
let refreshes: number;

/**
 * Services whose only real moving part is the probe under test.
 *
 * `presence` may be a list, consumed one call at a time, for the case where a
 * PATH refresh changes the answer between the first probe and the second.
 */
function servicesWith(
	presence: BinaryPresence | BinaryPresence[],
	opts: { pathMoved?: boolean } = {},
): Services {
	const answers = Array.isArray(presence) ? [...presence] : null;
	return {
		db,
		pty: {
			spawn: () => {
				spawned++;
				return "pty";
			},
			has: () => false,
		},
		hooksDir: scratch,
		notifyScriptPath: join(scratch, "notify.sh"),
		hookPort: 0,
		followUps: new FollowUps(),
		pendingSeeds: new Map(),
		probeAgent: async () =>
			answers ? (answers.shift() ?? "absent") : (presence as BinaryPresence),
		refreshPath: async () => {
			refreshes++;
			return opts.pathMoved ?? false;
		},
	} as unknown as Services;
}

beforeEach(() => {
	db = createTestDb();
	spawned = 0;
	refreshes = 0;
	scratch = mkdtempSync(join(tmpdir(), "ateam-missing-"));
	const project = repo.upsertProject(db, {
		repoPath: "/tmp/repo",
		name: "Repo",
		defaultBranch: "main",
	});
	if (!project) throw new Error("failed to seed project");
	const task = repo.createTask(db, {
		projectId: project.id,
		name: "a task",
		slug: "a-task",
		branch: "feat/a-task",
		baseBranch: "main",
		worktreePath: scratch,
	});
	repo.updateTask(db, task.id, { column: "backlog", agentStatus: null });
	taskId = task.id;
});

describe("launching an agent whose CLI is missing", () => {
	it("refuses, naming the agent and how to install it", async () => {
		const services = servicesWith("absent");
		await expect(
			spawnAgentInTask(services, () => {}, { taskId, agentId: "opencode" }),
		).rejects.toThrow(/OpenCode.*opencode.*not on PATH/s);
	});

	it("leaves nothing behind — no PTY, no session row, no 'running' card", async () => {
		const services = servicesWith("absent");
		await spawnAgentInTask(services, () => {}, { taskId, agentId: "opencode" }).catch(() => {});
		expect(spawned).toBe(0);
		expect(repo.listSessionsByTask(db, taskId)).toHaveLength(0);
		const task = repo.getTask(db, taskId);
		// The card must not claim work that never started.
		expect(task?.column).toBe("backlog");
		expect(task?.agentStatus).toBeNull();
	});

	it("launches anyway when the probe couldn't answer", async () => {
		// Fail open: a shell that times out knows nothing about the binary, and
		// refusing work on that basis would be a worse bug than the one the guard
		// prevents.
		const services = servicesWith("unknown");
		await spawnAgentInTask(services, () => {}, { taskId, agentId: "opencode" });
		expect(spawned).toBe(1);
		expect(repo.listSessionsByTask(db, taskId)).toHaveLength(1);
	});

	// The engine's PATH is a snapshot from when it started (login-env.ts), so an
	// agent installed since then is invisible to it. A loop tick is exactly the
	// caller that never opens the picker that would otherwise re-resolve it.
	it("re-resolves the login PATH before refusing, and launches if that found it", async () => {
		const services = servicesWith(["absent", "present"], { pathMoved: true });
		await spawnAgentInTask(services, () => {}, { taskId, agentId: "opencode" });
		expect(refreshes).toBe(1);
		expect(spawned).toBe(1);
	});

	it("doesn't re-probe when the PATH didn't move", async () => {
		const services = servicesWith(["absent", "present"], { pathMoved: false });
		await expect(
			spawnAgentInTask(services, () => {}, { taskId, agentId: "opencode" }),
		).rejects.toThrow(/not on PATH/);
		// It asked once, was told nothing changed, and refused on the first answer
		// rather than spending a second probe on an unchanged machine.
		expect(refreshes).toBe(1);
		expect(spawned).toBe(0);
	});

	it("launches when the CLI is there", async () => {
		const services = servicesWith("present");
		await spawnAgentInTask(services, () => {}, { taskId, agentId: "claude" });
		expect(spawned).toBe(1);
		expect(repo.getTask(db, taskId)?.agentStatus).toBe("running");
	});
});
