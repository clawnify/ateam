import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AteamDb } from "@ateam/db";
import { bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import { peerToken, verifyPeerToken } from "../src/agent-setup";
import { HookServer } from "../src/hooks/hook-server";
import { PeerMessenger } from "../src/peer-messages";

/**
 * The Claude mod's door over HTTP: the REAL hook server wired to the REAL
 * messenger the way engine.ts wires them, asked the way the mod asks.
 */

const SECRET = "test-secret";
let db: AteamDb;
let server: HookServer;
let messenger: PeerMessenger;
let taskId: string;

beforeAll(async () => {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	bootstrap(sqlite);
	db = drizzle(sqlite, { schema }) as unknown as AteamDb;
	const project = repo.upsertProject(db, { repoPath: "/tmp/repo", name: "Repo" });
	if (!project) throw new Error("seed");
	const task = repo.createTask(db, {
		projectId: project.id,
		name: "b",
		slug: "b",
		branch: "feat/b",
		baseBranch: "main",
		worktreePath: "/tmp/b",
		agentId: "claude",
	});
	taskId = task.id;
	repo.createSession(db, {
		taskId,
		agentId: "claude",
		terminalId: "term-1",
		cwd: "/tmp/b",
		agentSessionId: "term-1",
	});
	messenger = new PeerMessenger({
		db,
		isLive: (t) => t === "term-1",
		lastInputAt: () => null,
		stopSession: async () => {},
		launch: async () => ({ terminalId: "launched" }),
		log: () => {},
	});
	server = new HookServer();
	server.setPeerInbox({
		verify: (terminalId, token) => verifyPeerToken(SECRET, terminalId, token),
		wait: (terminalId) => messenger.wait(terminalId),
		waitUser: (terminalId) => messenger.waitUser(terminalId),
		ackUser: (terminalId, deliveryId, entered) =>
			messenger.ackUser(terminalId, deliveryId, entered),
	});
	await server.start();
});

afterAll(() => {
	messenger.stop();
	server.stop();
});

const base = () => `http://127.0.0.1:${server.port}/inbox/user`;
const headers = { "x-ateam-terminal-token": peerToken(SECRET, "term-1") };

describe("/inbox/user", () => {
	it("refuses a terminal that can't prove itself", async () => {
		const res = await fetch(`${base()}/wait?terminalId=term-1`, {
			headers: { "x-ateam-terminal-token": "wrong" },
		});
		expect(res.status).toBe(401);
	});

	it("hands the user's words as JSON, and takes the mod's ack", async () => {
		const asked = fetch(`${base()}/wait?terminalId=term-1`, { headers });
		// Let the long-poll register before the answer arrives.
		await new Promise((r) => setTimeout(r, 50));
		messenger.sendFrom("user", { to: taskId, body: "Build as proposed" });
		const res = await asked;
		expect(res.status).toBe(200);
		const batch = (await res.json()) as { deliveryId: string; text: string };
		expect(batch.text).toContain("Build as proposed");

		const unknown = await fetch(`${base()}/ack?terminalId=term-1&deliveryId=nope&entered=1`, {
			method: "POST",
			headers,
		});
		expect(unknown.status).toBe(404);
		const ack = await fetch(
			`${base()}/ack?terminalId=term-1&deliveryId=${batch.deliveryId}&entered=1`,
			{ method: "POST", headers },
		);
		expect(ack.status).toBe(204);
		expect(repo.listPendingPeerMessages(db, taskId)).toHaveLength(0);
	});
});
