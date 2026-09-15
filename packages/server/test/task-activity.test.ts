import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { type AteamDb, bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import { toTaskDTO } from "../src/services";

test("background refreshes cannot promote tasks without activity history above recent work", () => {
	const sqlite = new Database(":memory:");
	try {
		bootstrap(sqlite);
		const db = drizzle(sqlite, { schema }) as unknown as AteamDb;
		const project = repo.upsertProject(db, { repoPath: "/tmp/repo", name: "Repo" });
		assert(project);
		const createdAt = 1_700_000_000_000;
		const tasks = ["opencode", "shell", "codex"].map((agentId) =>
			repo.createTask(db, {
				projectId: project.id,
				name: agentId,
				slug: agentId,
				branch: `feat/${agentId}`,
				baseBranch: "main",
				worktreePath: `/tmp/${agentId}`,
				agentId,
				createdAt,
				updatedAt: createdAt,
				lastEventAt: agentId === "codex" ? createdAt + 1000 : null,
			}),
		);
		const before = tasks.map((task) => toTaskDTO(task).lastEventAt);
		// The sweep writes fresh git facts through updateTask, which also stamps
		// updatedAt. Reading a card or repairing metadata uses this same path.
		const refreshed = tasks.map((task) => {
			const updated = repo.updateTask(db, task.id, {
				gitStatus: { ahead: 0, behind: 0, dirty: 0, updatedAt: Date.now() },
			});
			assert(updated);
			return updated;
		});
		expect(refreshed.every((task) => (task.updatedAt ?? 0) > createdAt + 1000)).toBe(true);
		const dtos = refreshed.map((task) => toTaskDTO(task));
		expect(dtos.map((task) => task.lastEventAt)).toEqual(before);
		expect(dtos.map((task) => task.lastEventAt)).toEqual([createdAt, createdAt, createdAt + 1000]);
		dtos.sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0));
		expect(dtos[0]?.agentId).toBe("codex");
		assert(tasks[0]);
		const active = repo.updateTask(db, tasks[0].id, { lastEventAt: createdAt + 2000 });
		assert(active);
		expect(toTaskDTO(active).lastEventAt).toBe(createdAt + 2000);
		// Legacy rows with neither timestamp must not borrow maintenance time.
		expect(toTaskDTO({ ...active, lastEventAt: null, createdAt: null }).lastEventAt).toBeNull();
	} finally {
		sqlite.close();
	}
});
