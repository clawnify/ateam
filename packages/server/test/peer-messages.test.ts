import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentSession, AteamDb, Task } from "@ateam/db";
import { bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import {
	type DeliveryFacts,
	formatForRecipient,
	INPUT_QUIET_MS,
	LISTENER_GRACE_MS,
	MAX_FROM_LEAD,
	MAX_HOPS,
	MAX_PER_SENDER,
	nextHop,
	PEER_SEARCH_LIMIT,
	PeerMessenger,
	planDelivery,
} from "../src/peer-messages";

const NOW = 1_000_000_000;

function facts(over: Partial<DeliveryFacts> = {}): DeliveryFacts {
	return {
		live: { agentId: "codex", status: "idle", hasListener: false },
		lastInputAt: null,
		lastEventAt: NOW - 5 * 60_000,
		oldestPendingAt: NOW - 10 * 60_000,
		now: NOW,
		...over,
	};
}

describe("planDelivery", () => {
	it("launches when no agent is running", () => {
		expect(planDelivery(facts({ live: null }))).toBe("launch");
	});

	it("hands to a listener whatever the agent is doing", () => {
		for (const status of ["idle", "running", "awaiting_input"]) {
			expect(planDelivery(facts({ live: { agentId: "claude", status, hasListener: true } }))).toBe(
				"listener",
			);
		}
	});

	// Restarting throws the turn (or the pending question) away.
	it("waits for a busy agent without a listener", () => {
		expect(
			planDelivery(facts({ live: { agentId: "codex", status: "running", hasListener: false } })),
		).toBe("wait");
		expect(
			planDelivery(
				facts({ live: { agentId: "codex", status: "awaiting_input", hasListener: false } }),
			),
		).toBe("wait");
	});

	it("restarts an idle agent without a listener", () => {
		expect(planDelivery(facts())).toBe("restart");
	});

	it("never restarts under someone typing", () => {
		expect(planDelivery(facts({ lastInputAt: NOW - INPUT_QUIET_MS + 1 }))).toBe("wait");
	});

	// Codex reports no turn START without its trusted hooks, so after a prompt is
	// typed its status still reads idle while it works.
	it("treats input since the last event as a turn in flight", () => {
		expect(
			planDelivery(facts({ lastEventAt: NOW - 10 * 60_000, lastInputAt: NOW - 5 * 60_000 })),
		).toBe("wait");
		expect(
			planDelivery(facts({ lastEventAt: NOW - 2 * 60_000, lastInputAt: NOW - 5 * 60_000 })),
		).toBe("restart");
	});

	it("gives a harness that listens time to register before restarting it", () => {
		const claude = { agentId: "claude", status: "idle", hasListener: false };
		expect(
			planDelivery(facts({ live: claude, oldestPendingAt: NOW - LISTENER_GRACE_MS + 1 })),
		).toBe("wait");
		expect(planDelivery(facts({ live: claude, oldestPendingAt: NOW - LISTENER_GRACE_MS }))).toBe(
			"restart",
		);
	});
});

describe("nextHop", () => {
	it("starts a conversation at 1 and answers one more than the message it replies to", () => {
		expect(nextHop([], "b")).toBe(1);
		expect(
			nextHop(
				[
					{ fromTaskId: "b", hop: 3 },
					{ fromTaskId: "a", hop: 2 },
				],
				"b",
			),
		).toBe(4);
		expect(nextHop([{ fromTaskId: "a", hop: 2 }], "b")).toBe(1);
	});
});

describe("formatForRecipient", () => {
	it("names the sender, says it is not the user, and how to reply", () => {
		const text = formatForRecipient([
			{ body: "API returns 401 now", from: { taskId: "t-1", name: "fix auth", agent: "Codex" } },
		]);
		expect(text).toContain('task "fix auth" (task id t-1)');
		expect(text).toContain("not from the user");
		expect(text).toContain('send_message tool with to="t-1"');
		expect(text.endsWith("API returns 401 now")).toBe(true);
	});
});

describe("formatForRecipient from the Lead", () => {
	it("says it relays the user and to answer in the reply, not with send_message", () => {
		const text = formatForRecipient([{ body: "rebase on main", from: "lead" }]);
		expect(text).toContain("Message from the Lead");
		expect(text).toContain("relays the user's instructions");
		expect(text).toContain("answer in your reply rather than with send_message");
		expect(text.endsWith("rebase on main")).toBe(true);
	});
});

// ---- the messenger against a real (in-memory) db ---------------------------

function createTestDb(): AteamDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	bootstrap(sqlite);
	return drizzle(sqlite, { schema }) as unknown as AteamDb;
}

let db: AteamDb;
let live: Set<string>;
let now: number;
let launched: { taskId: string; prompt: string }[];
let stopped: string[];
let messenger: PeerMessenger;
let projectId: string;

function addTask(name: string, agentId: string | null = null): Task {
	return repo.createTask(db, {
		projectId,
		name,
		slug: name,
		branch: `feat/${name}`,
		baseBranch: "main",
		worktreePath: `/tmp/${name}`,
		agentId,
	});
}

function addSession(
	task: Task,
	agentId: string,
	terminalId: string,
	status = "idle",
): AgentSession {
	repo.createSession(db, { taskId: task.id, agentId, terminalId, cwd: task.worktreePath });
	const row = repo.getSessionByTerminal(db, terminalId) as AgentSession;
	repo.updateSession(db, row.id, { status: status as "idle", lastEventAt: now - 5 * 60_000 });
	live.add(terminalId);
	return repo.getSessionByTerminal(db, terminalId) as AgentSession;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
	db = createTestDb();
	live = new Set();
	now = NOW;
	launched = [];
	stopped = [];
	const project = repo.upsertProject(db, { repoPath: "/tmp/repo", name: "Repo" });
	if (!project) throw new Error("seed");
	projectId = project.id;
	messenger = new PeerMessenger({
		db,
		isLive: (t) => live.has(t),
		lastInputAt: () => null,
		stopSession: async (s) => {
			stopped.push(s.terminalId);
			live.delete(s.terminalId);
		},
		launch: async (task, prompt) => {
			launched.push({ taskId: task.id, prompt });
		},
		log: () => {},
		now: () => now,
	});
});

describe("PeerMessenger.send", () => {
	it("refuses a sender that is not a task's agent, an empty body and itself", () => {
		const a = addTask("a");
		addSession(a, "claude", "ta");
		expect(messenger.send({ fromTerminalId: "nope", to: a.id, body: "hi" }).ok).toBe(false);
		expect(messenger.send({ fromTerminalId: "ta", to: a.id, body: "hi" }).reason).toBe(
			"that task is yours",
		);
		const b = addTask("b");
		expect(messenger.send({ fromTerminalId: "ta", to: b.id, body: "   " }).ok).toBe(false);
	});

	it("finds the recipient by id, name or branch, and says when a name is ambiguous", () => {
		const a = addTask("a");
		addSession(a, "claude", "ta");
		const b = addTask("fix-auth");
		expect(messenger.send({ fromTerminalId: "ta", to: "FIX-AUTH", body: "x" }).ok).toBe(true);
		expect(messenger.send({ fromTerminalId: "ta", to: "feat/fix-auth", body: "x" }).ok).toBe(true);
		expect(messenger.send({ fromTerminalId: "ta", to: "nobody", body: "x" }).reason).toContain(
			"list_peers",
		);
		expect(repo.listPendingPeerMessages(db, b.id).length + launched.length).toBeGreaterThan(0);
	});

	// A task named from its prompt is renamed once by the model; its branch
	// keeps the first words, so a peer that learned them still reaches it.
	it("finds a renamed task by the name its branch was made from, never guessing between two", () => {
		const a = addTask("a");
		addSession(a, "claude", "ta");
		const first = (name: string, branch: string) =>
			repo.createTask(db, {
				projectId,
				name,
				slug: branch,
				branch,
				baseBranch: "main",
				worktreePath: `/tmp/${branch}`,
			});
		const renamed = first("Unread dot in collapsed sidebar", "on-sidebar-collapsed-i-am-not");
		const sent = messenger.send({
			fromTerminalId: "ta",
			to: "on sidebar collapsed I am not",
			body: "x",
		});
		expect(sent.ok).toBe(true);
		expect(repo.listPendingPeerMessages(db, renamed.id).length + launched.length).toBeGreaterThan(
			0,
		);
		// A second task with the same first words got the -2 branch: the old name
		// now fits both, so it is refused rather than delivered to the wrong one.
		first("Collapsed sidebar badge", "on-sidebar-collapsed-i-am-not-2");
		expect(
			messenger.send({ fromTerminalId: "ta", to: "on sidebar collapsed I am not", body: "x" })
				.reason,
		).toContain("matches 2 tasks");
	});

	it("lets a task that carries a name now win over one whose branch was made from it", () => {
		const a = addTask("a");
		addSession(a, "claude", "ta");
		const current = addTask("fix login");
		repo.createTask(db, {
			projectId,
			name: "Login redirect loop",
			slug: "fix-login-2",
			branch: "fix-login-2",
			baseBranch: "main",
			worktreePath: "/tmp/fix-login-2",
		});
		expect(messenger.send({ fromTerminalId: "ta", to: "fix login", body: "x" }).ok).toBe(true);
		expect(repo.listPendingPeerMessages(db, current.id).length + launched.length).toBeGreaterThan(
			0,
		);
	});

	it("launches a task whose agent is not running, with the message as the prompt", async () => {
		const a = addTask("a");
		addSession(a, "claude", "ta");
		const b = addTask("b", "codex");
		const r = messenger.send({ fromTerminalId: "ta", to: b.id, body: "please rebase" });
		expect(r.reason).toContain("starting it");
		await flush();
		expect(launched).toHaveLength(1);
		expect(launched[0]?.taskId).toBe(b.id);
		expect(launched[0]?.prompt).toContain("please rebase");
		expect(launched[0]?.prompt).toContain(`to="${a.id}"`);
		expect(repo.listPendingPeerMessages(db, b.id)).toHaveLength(0);
	});

	it("caps a back-and-forth between two tasks", () => {
		const a = addTask("a");
		const b = addTask("b");
		addSession(a, "claude", "ta");
		addSession(b, "claude", "tb", "running");
		for (let i = 1; i <= MAX_HOPS; i++) {
			const from = i % 2 ? "ta" : "tb";
			const to = i % 2 ? b.id : a.id;
			expect(messenger.send({ fromTerminalId: from, to, body: `turn ${i}` }).ok).toBe(true);
			now += 1000;
		}
		const over = messenger.send({ fromTerminalId: "ta", to: b.id, body: "one more" });
		expect(over.ok).toBe(false);
		expect(over.reason).toContain("tell the user");
	});

	it("caps how much one task sends", () => {
		const a = addTask("a");
		addSession(a, "claude", "ta");
		const targets = Array.from({ length: MAX_PER_SENDER + 1 }, (_, i) => {
			const t = addTask(`t${i}`);
			addSession(t, "claude", `t${i}`, "running");
			return t;
		});
		for (const t of targets.slice(0, MAX_PER_SENDER)) {
			expect(messenger.send({ fromTerminalId: "ta", to: t.id, body: "x" }).ok).toBe(true);
		}
		const last = targets[MAX_PER_SENDER] as Task;
		expect(messenger.send({ fromTerminalId: "ta", to: last.id, body: "x" }).reason).toContain(
			"rate limit",
		);
	});
});

describe("PeerMessenger listeners", () => {
	it("hands a pending batch to a listener as soon as it asks", async () => {
		const a = addTask("a");
		const b = addTask("b");
		addSession(a, "claude", "ta");
		addSession(b, "claude", "tb", "running");
		messenger.send({ fromTerminalId: "ta", to: b.id, body: "one" });
		messenger.send({ fromTerminalId: "ta", to: b.id, body: "two" });
		const { result } = messenger.wait("tb");
		const out = await result;
		expect(out.kind).toBe("message");
		if (out.kind === "message") {
			expect(out.text).toContain("one");
			expect(out.text).toContain("two");
		}
		expect(repo.listPendingPeerMessages(db, b.id)).toHaveLength(0);
	});

	it("wakes a listener already waiting when a message arrives", async () => {
		const a = addTask("a");
		const b = addTask("b");
		addSession(a, "claude", "ta");
		addSession(b, "opencode", "tb");
		const { result } = messenger.wait("tb");
		const r = messenger.send({ fromTerminalId: "ta", to: b.id, body: "ping" });
		expect(r.reason).toContain("delivered to its agent now");
		expect((await result).kind).toBe("message");
		expect(launched).toHaveLength(0);
		expect(stopped).toHaveLength(0);
	});

	it("keeps only the newest listener per terminal", async () => {
		const b = addTask("b");
		addSession(b, "claude", "tb");
		const first = messenger.wait("tb");
		messenger.wait("tb");
		expect((await first.result).kind).toBe("superseded");
	});

	it("tells a listener on a dead terminal it is gone", async () => {
		const b = addTask("b");
		addSession(b, "claude", "tb");
		live.delete("tb");
		expect((await messenger.wait("tb").result).kind).toBe("gone");
	});

	it("restarts an idle Codex with the message, keeping its conversation", async () => {
		const a = addTask("a");
		const b = addTask("b", "codex");
		addSession(a, "claude", "ta");
		addSession(b, "codex", "tb", "idle");
		messenger.send({ fromTerminalId: "ta", to: b.id, body: "your branch conflicts with mine" });
		await flush();
		await flush();
		expect(stopped).toEqual(["tb"]);
		expect(launched[0]?.prompt).toContain("your branch conflicts with mine");
	});

	it("holds a message for a Codex mid-turn until its turn ends", async () => {
		const a = addTask("a");
		const b = addTask("b", "codex");
		addSession(a, "claude", "ta");
		const s = addSession(b, "codex", "tb", "running");
		expect(messenger.send({ fromTerminalId: "ta", to: b.id, body: "x" }).reason).toContain(
			"queued",
		);
		await flush();
		expect(stopped).toHaveLength(0);
		repo.updateSession(db, s.id, { status: "idle", lastEventAt: now });
		messenger.kick(b.id);
		await flush();
		await flush();
		expect(stopped).toEqual(["tb"]);
		expect(launched).toHaveLength(1);
	});
});

describe("PeerMessenger.listPeers", () => {
	it("lists tasks outside merged with their state, marking the caller", () => {
		const a = addTask("a", "claude");
		const b = addTask("b", "codex");
		const c = addTask("c");
		repo.updateTask(db, c.id, { column: "merged" });
		addSession(a, "claude", "ta", "running");
		const peers = messenger.listPeers("ta");
		expect(peers.map((p) => p.name).sort()).toEqual(["a", "b"]);
		expect(peers.find((p) => p.taskId === a.id)).toMatchObject({
			state: "working",
			you: true,
			project: "Repo",
			// The seed project has no GitHub remote, so its repo is the clone's path.
			repo: "/tmp/repo",
		});
		expect(peers.find((p) => p.taskId === b.id)).toMatchObject({
			state: "not_running",
			agent: "codex",
			summary: null,
		});
	});

	it("carries each task's summary once one is written", () => {
		const a = addTask("a", "claude");
		repo.updateTask(db, a.id, { summary: "Board loads in 200ms; PR #12 is open." });
		expect(messenger.listPeers(undefined)[0]?.summary).toBe(
			"Board loads in 200ms; PR #12 is open.",
		);
	});
});

describe("PeerMessenger.searchPeers", () => {
	it("finds merged and archived tasks by every word, in any case", () => {
		const built = addTask("agents-can-propose");
		repo.updateTask(db, built.id, {
			column: "merged",
			description: "Add propose_task and propose_loop to the board MCP",
		});
		const old = addTask("old-loop-work");
		repo.updateTask(db, old.id, { description: "propose_loop schedule", archivedAt: now });
		addTask("unrelated");
		addSession(addTask("me"), "claude", "ta", "running");

		// Hidden from the plain listing, found by a search.
		expect(messenger.listPeers("ta").map((p) => p.name)).not.toContain("agents-can-propose");
		const r = messenger.searchPeers("ta", "PROPOSE_loop");
		expect(r.more).toBe(false);
		expect(r.peers.map((p) => p.name).sort()).toEqual(["agents-can-propose", "old-loop-work"]);
		expect(r.peers.find((p) => p.taskId === built.id)).toMatchObject({ column: "merged" });
		expect(r.peers.find((p) => p.taskId === built.id)?.archived).toBeUndefined();
		expect(r.peers.find((p) => p.taskId === old.id)?.archived).toBe(true);

		// Every word must match, each in any field: the branch is feat/<name>.
		expect(messenger.searchPeers("ta", "feat/agents board").peers.map((p) => p.name)).toEqual([
			"agents-can-propose",
		]);
		expect(messenger.searchPeers("ta", "propose nowhere").peers).toEqual([]);
		// `_` is a literal character, not a LIKE wildcard.
		expect(messenger.searchPeers("ta", "propose_t").peers.map((p) => p.name)).toEqual([
			"agents-can-propose",
		]);
		expect(messenger.searchPeers("ta", "me").peers.find((p) => p.name === "me")?.you).toBe(true);
	});

	it("caps the matches and says more matched", () => {
		for (let i = 0; i <= PEER_SEARCH_LIMIT; i++) addTask(`fix-${i}`);
		const r = messenger.searchPeers(undefined, "fix");
		expect(r.peers).toHaveLength(PEER_SEARCH_LIMIT);
		expect(r.more).toBe(true);
	});
});

describe("PeerMessenger.sendFrom lead", () => {
	it("starts a stopped task with the message, framed as from the Lead", async () => {
		const b = addTask("b", "codex");
		const r = messenger.sendFrom("lead", { to: "b", body: "please rebase" });
		expect(r.ok).toBe(true);
		expect(r.reason).toContain("starting it");
		await flush();
		expect(launched).toHaveLength(1);
		expect(launched[0]?.taskId).toBe(b.id);
		expect(launched[0]?.prompt).toContain("Message from the Lead");
		expect(launched[0]?.prompt).toContain("please rebase");
	});

	it("refuses an empty body and an unknown task", () => {
		addTask("b");
		expect(messenger.sendFrom("lead", { to: "b", body: "  " }).ok).toBe(false);
		expect(messenger.sendFrom("lead", { to: "nobody", body: "x" }).ok).toBe(false);
	});

	it("caps how much the Lead sends", () => {
		const b = addTask("b");
		addSession(b, "claude", "tb", "running");
		for (let i = 0; i < MAX_FROM_LEAD; i++) {
			expect(messenger.sendFrom("lead", { to: b.id, body: `m${i}` }).ok).toBe(true);
		}
		const over = messenger.sendFrom("lead", { to: b.id, body: "one more" });
		expect(over.ok).toBe(false);
		expect(over.reason).toContain("rate limit");
	});
});
