import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { AteamDb } from "@ateam/db";
import { bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import type { ClassifyTurnInput, TurnVerdict } from "../src/jev";
import { createTurnClassifier } from "../src/turn-classifier";

function createTestDb(): AteamDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	bootstrap(sqlite);
	return drizzle(sqlite, { schema }) as unknown as AteamDb;
}

let db: AteamDb;
let notified: string[];

function seedTask(name: string): string {
	const project = repo.upsertProject(db, { repoPath: "/tmp/repo", name: "Repo", defaultBranch: "main" });
	if (!project) throw new Error("failed to seed project");
	const id = repo.createTask(db, {
		projectId: project.id,
		name,
		slug: name,
		branch: `b/${name}`,
		baseBranch: "main",
		worktreePath: `/tmp/${name}`,
		description: "add a database",
	}).id;
	// Where the rule leaves a finished turn.
	repo.updateTask(db, id, { column: "review", agentStatus: "idle" });
	return id;
}

const needsYou: TurnVerdict = {
	step: "needs_attention",
	reason: "the agent is waiting on your answer",
	confidence: 0.98,
	legs: { asks_user: 0.99, blocked: 0.01, promises_future_work: 0.01, claims_done: 0.1 },
};

function classifier(opts: {
	key?: string;
	verdict?: TurnVerdict | null;
	onAsk?: (input: ClassifyTurnInput) => void | Promise<void>;
}) {
	return createTurnClassifier({
		db,
		notifyTaskUpdated: (id) => notified.push(id),
		apiKey: () => opts.key,
		classify: async (input) => {
			await opts.onAsk?.(input);
			return opts.verdict ?? null;
		},
		log: () => {},
	});
}

beforeEach(() => {
	db = createTestDb();
	notified = [];
});

describe("turn classifier", () => {
	it("moves a card waiting on the user to Needs you, audited", async () => {
		const id = seedTask("q");
		await classifier({ key: "k", verdict: needsYou }).turnEnded(id, "Postgres or SQLite?");
		expect(repo.getTask(db, id)?.column).toBe("needs_attention");
		const [change] = repo.listBoardChanges(db, { taskId: id });
		expect(change).toMatchObject({
			fromColumn: "review",
			toColumn: "needs_attention",
			source: "classifier",
			reason: needsYou.reason,
		});
		expect(notified).toEqual([id]);
	});

	it("never calls out without a key: the rule's Review stands", async () => {
		const id = seedTask("nokey");
		let asked = false;
		await classifier({
			verdict: needsYou,
			onAsk: () => {
				asked = true;
			},
		}).turnEnded(id, "?");
		expect(asked).toBe(false);
		expect(repo.getTask(db, id)?.column).toBe("review");
	});

	it("leaves a loop's card alone, since Needs you would wedge its next tick", async () => {
		const id = seedTask("loop");
		repo.ensureLoop(db, {
			id: "l1",
			definitionId: "l1",
			scopeKey: null,
			kind: "user",
			templateId: "agent-session",
			name: "Nightly",
			projectId: null,
			config: { prompt: "go", taskId: id },
			cadenceMode: "fixed",
			intervalMs: 3_600_000,
			enabled: true,
		});
		await classifier({ key: "k", verdict: needsYou }).turnEnded(id, "?");
		expect(repo.getTask(db, id)?.column).toBe("review");
	});

	it("drops a verdict once a newer turn has ended", async () => {
		const id = seedTask("race");
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let first = true;
		const c = classifier({
			key: "k",
			verdict: needsYou,
			onAsk: async () => {
				if (first) {
					first = false;
					await gate;
				}
			},
		});
		const slow = c.turnEnded(id, "Postgres or SQLite?");
		// The next turn ends with nothing to read; its Stop still retires the first.
		await c.turnEnded(id, undefined);
		release();
		await slow;
		expect(repo.getTask(db, id)?.column).toBe("review");
	});

	it("drops a verdict when the agent is working again", async () => {
		const id = seedTask("resumed");
		await classifier({
			key: "k",
			verdict: needsYou,
			onAsk: () => {
				repo.updateTask(db, id, { column: "running", agentStatus: "running" });
			},
		}).turnEnded(id, "?");
		expect(repo.getTask(db, id)?.column).toBe("running");
	});

	it("asks with the user's latest reply, else the task's opening prompt", async () => {
		const id = seedTask("prompt");
		const seen: (string | null | undefined)[] = [];
		const c = classifier({ key: "k", verdict: null, onAsk: (i) => void seen.push(i.userMessage) });
		await c.turnEnded(id, "done");
		c.userReplied(id, "now add tests");
		await c.turnEnded(id, "done");
		expect(seen).toEqual(["add a database", "now add tests"]);
	});
});
