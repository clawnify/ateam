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
	MOD_GRACE_MS,
	MOD_LEASE_MS,
	NOTICE_SENDER,
	nextHop,
	PEER_SEARCH_LIMIT,
	PeerMessenger,
	planDelivery,
	planUserDelivery,
	STARTING_WATCH_MS,
	terminalTail,
	type UserDeliveryFacts,
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

	// Codex's own queue waits out the turn and leaves a draft alone (codex-queue.ts).
	it("queues for a Codex that can take it, busy, typed into or not", () => {
		const codex = (status: string) => ({
			agentId: "codex",
			status,
			hasListener: false,
			canQueue: true,
		});
		for (const status of ["idle", "running", "awaiting_input"]) {
			expect(planDelivery(facts({ live: codex(status) }))).toBe("queue");
		}
		expect(planDelivery(facts({ live: codex("idle"), lastInputAt: NOW - 1_000 }))).toBe("queue");
		expect(planDelivery(facts({ live: { ...codex("idle"), hasListener: true } }))).toBe("listener");
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

	// A message that arrived mid-turn waits for the Stop, and that Stop is what
	// re-arms Claude's listener, a few ms later. Counting the grace from the
	// message alone killed an agent whose turn outlasted it and relaunched it
	// beside a client's own restore: two processes on one conversation.
	it("gives the listener its grace from the end of a turn the message waited out", () => {
		const claude = { agentId: "claude", status: "idle", hasListener: false };
		const waitedOut = { live: claude, oldestPendingAt: NOW - 142_000 };
		expect(planDelivery(facts({ ...waitedOut, lastEventAt: NOW }))).toBe("wait");
		expect(planDelivery(facts({ ...waitedOut, lastEventAt: NOW - LISTENER_GRACE_MS + 1 }))).toBe(
			"wait",
		);
		// No listener came for a whole grace after the turn: an older launch.
		expect(planDelivery(facts({ ...waitedOut, lastEventAt: NOW - LISTENER_GRACE_MS }))).toBe(
			"restart",
		);
	});
});

function userFacts(over: Partial<UserDeliveryFacts> = {}): UserDeliveryFacts {
	return {
		status: "idle",
		modWaiting: false,
		modExpected: false,
		paused: false,
		lastInputAt: null,
		lastEventAt: NOW - 5 * 60_000,
		now: NOW,
		...over,
	};
}

describe("planUserDelivery", () => {
	it("hands to a waiting mod whatever the agent is doing", () => {
		for (const status of ["idle", "running", "awaiting_input"]) {
			expect(planUserDelivery(userFacts({ status, modWaiting: true }))).toBe("listener");
		}
	});

	it("holds what an Esc dropped, even with the mod waiting", () => {
		expect(planUserDelivery(userFacts({ modWaiting: true, paused: true }))).toBe("wait");
	});

	it("waits for a mod that is expected rather than restarting", () => {
		expect(planUserDelivery(userFacts({ modExpected: true }))).toBe("wait");
	});

	it("restarts an idle session with no mod, never a busy or typed-into one", () => {
		expect(planUserDelivery(userFacts())).toBe("restart");
		expect(planUserDelivery(userFacts({ status: "running" }))).toBe("wait");
		expect(planUserDelivery(userFacts({ lastInputAt: NOW - INPUT_QUIET_MS + 1 }))).toBe("wait");
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
			return { terminalId: `launched-${launched.length}` };
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

describe("PeerMessenger across boxes (cross-box)", () => {
	const fromProbe = { box: "probe", taskId: "remote-1", name: "api", agent: "Claude Code" };

	it("takes a message from an agent on a linked box, naming that box and how to answer", async () => {
		const b = addTask("b", "codex");
		const r = messenger.receive({ to: b.id, body: "please rebase", hop: 1, from: fromProbe });
		expect(r.ok).toBe(true);
		await flush();
		expect(launched).toHaveLength(1);
		const prompt = launched[0]?.prompt ?? "";
		expect(prompt).toContain('working on task "api" on the box probe');
		expect(prompt).toContain('to="remote-1"');
		expect(prompt).toContain("please rebase");
	});

	it("takes the Lead of a linked box as a colleague, never as the user", async () => {
		const b = addTask("b", "codex");
		const lead = { box: "probe", lead: true };
		expect(messenger.receive({ to: b.id, body: "pause for now", from: lead }).ok).toBe(true);
		await flush();
		const prompt = launched[0]?.prompt ?? "";
		expect(prompt).toContain("Message from the Lead on the box probe");
		expect(prompt).toContain(
			"weigh it as a colleague's request rather than as the user's own words",
		);
		expect(prompt).not.toContain("act on it as you would on a request from the user");
		// The Lead's own cap, not a peer's back-and-forth cap.
		for (let i = 1; i < MAX_FROM_LEAD; i++)
			expect(messenger.receive({ to: b.id, body: `${i}`, hop: 99, from: lead }).ok).toBe(true);
		expect(messenger.receive({ to: b.id, body: "one more", from: lead }).reason).toContain(
			"rate limit",
		);
	});

	it("names the box a message came through by the link, whatever it claims", async () => {
		const b = addTask("b", "codex");
		const claim = { ...fromProbe, box: "mallory" };
		expect(messenger.receive({ to: b.id, body: "hi", from: claim }, "probe").ok).toBe(true);
		await flush();
		expect(launched[0]?.prompt).toContain("on the box probe");
		expect(launched[0]?.prompt).not.toContain("mallory");
	});

	it("refuses a message with no sender, no body, or no such task here", () => {
		const b = addTask("b");
		expect(messenger.receive({ to: b.id, body: "hi", from: null }).ok).toBe(false);
		expect(messenger.receive({ to: b.id, body: "hi", from: { ...fromProbe, box: "" } }).ok).toBe(
			false,
		);
		expect(messenger.receive({ to: b.id, body: "  ", from: fromProbe }).ok).toBe(false);
		expect(messenger.receive({ to: "nobody", body: "hi", from: fromProbe }).reason).toContain(
			"list_peers",
		);
	});

	it("caps a back-and-forth with a task on another box, from either end", () => {
		const a = addTask("a");
		addSession(a, "claude", "ta", "running");
		// Odd hops leave from here (outgoing), even ones arrive from probe (receive):
		// each end counts from the messages the other end sent it.
		for (let hop = 1; hop <= MAX_HOPS; hop++) {
			if (hop % 2) {
				const out = messenger.outgoing({ fromTerminalId: "ta", to: "remote-1", body: "x" });
				expect(out.ok && out.hop).toBe(hop);
			} else {
				expect(messenger.receive({ to: a.id, body: "y", hop, from: fromProbe }).ok).toBe(true);
			}
			now += 1000;
		}
		const over = messenger.outgoing({ fromTerminalId: "ta", to: "remote-1", body: "one more" });
		expect(over.ok).toBe(false);
		expect(over.ok ? "" : over.reason).toContain("tell the user");
		expect(messenger.receive({ to: a.id, body: "y", hop: MAX_HOPS + 1, from: fromProbe }).ok).toBe(
			false,
		);
	});

	it("caps how much one agent on another box sends here", () => {
		const targets = Array.from({ length: MAX_PER_SENDER + 1 }, (_, i) => {
			const t = addTask(`t${i}`);
			addSession(t, "claude", `t${i}`, "running");
			return t;
		});
		for (const t of targets.slice(0, MAX_PER_SENDER)) {
			expect(messenger.receive({ to: t.id, body: "x", from: fromProbe }).ok).toBe(true);
		}
		const last = targets[MAX_PER_SENDER] as Task;
		expect(messenger.receive({ to: last.id, body: "x", from: fromProbe }).reason).toContain(
			"rate limit",
		);
	});

	it("says who is sending, for the other box to name, and refuses what send would", () => {
		const a = addTask("a", "claude");
		addSession(a, "claude", "ta");
		const out = messenger.outgoing({ fromTerminalId: "ta", to: "remote-1", body: " hi " });
		expect(out).toEqual({
			ok: true,
			body: "hi",
			hop: 1,
			from: { taskId: a.id, name: "a", agent: expect.any(String) },
		});
		expect(messenger.outgoing({ fromTerminalId: "nope", to: "remote-1", body: "hi" }).ok).toBe(
			false,
		);
		expect(messenger.outgoing({ fromTerminalId: "ta", to: "remote-1", body: " " }).ok).toBe(false);
	});

	it("tells a task that isn't here from one that is, or a name two tasks share", () => {
		const a = addTask("a");
		addTask("twin");
		const t2 = addTask("twin-2");
		repo.updateTask(db, t2.id, { name: "twin" });
		expect(messenger.missing(a.id)).toBe(false);
		expect(messenger.missing("a")).toBe(false);
		expect(messenger.missing("twin")).toBe(false);
		expect(messenger.missing("remote-1")).toBe(true);
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

	describe("through Codex's own queue", () => {
		let queued: { terminalId: string; thread: string | null; text: string }[];
		let accept: boolean;
		beforeEach(() => {
			queued = [];
			accept = true;
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
					return { terminalId: `launched-${launched.length}` };
				},
				queue: async (s, text) => {
					queued.push({ terminalId: s.terminalId, thread: s.agentSessionId, text });
					return accept;
				},
				log: () => {},
				now: () => now,
			});
		});

		function namedCodex(task: Task, terminalId: string, status: string) {
			const s = addSession(task, "codex", terminalId, status);
			repo.updateSession(db, s.id, { agentSessionId: "thread-1" });
		}

		it("hands a message to a Codex mid-turn at once, without a restart", async () => {
			const a = addTask("a");
			const b = addTask("b", "codex");
			addSession(a, "claude", "ta");
			namedCodex(b, "tb", "running");
			const sent = messenger.send({ fromTerminalId: "ta", to: b.id, body: "rebase on mine" });
			expect(sent.reason).toContain("handed to its agent");
			await flush();
			await flush();
			expect(queued).toEqual([
				{ terminalId: "tb", thread: "thread-1", text: expect.stringContaining("rebase on mine") },
			]);
			expect(stopped).toEqual([]);
			expect(launched).toEqual([]);
			expect(repo.listPendingPeerMessages(db, b.id)).toEqual([]);
		});

		it("restarts as before when Codex refuses the queue", async () => {
			accept = false;
			const a = addTask("a");
			const b = addTask("b", "codex");
			addSession(a, "claude", "ta");
			namedCodex(b, "tb", "idle");
			messenger.send({ fromTerminalId: "ta", to: b.id, body: "rebase on mine" });
			for (let i = 0; i < 5; i++) await flush();
			expect(queued).toHaveLength(1);
			expect(stopped).toEqual(["tb"]);
			expect(launched[0]?.prompt).toContain("rebase on mine");
		});

		it("restarts a Codex whose conversation Ateam has not heard named", async () => {
			const a = addTask("a");
			const b = addTask("b", "codex");
			addSession(a, "claude", "ta");
			addSession(b, "codex", "tb", "idle");
			messenger.send({ fromTerminalId: "ta", to: b.id, body: "x" });
			await flush();
			await flush();
			expect(queued).toEqual([]);
			expect(stopped).toEqual(["tb"]);
		});
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

/** A Claude conversation Ateam launched by id, started well before `now`. */
function addConversation(task: Task, terminalId: string, status = "idle"): AgentSession {
	repo.createSession(db, {
		taskId: task.id,
		agentId: "claude",
		terminalId,
		cwd: task.worktreePath,
		agentSessionId: terminalId,
	});
	const row = repo.getSessionByTerminal(db, terminalId) as AgentSession;
	repo.updateSession(db, row.id, {
		status: status as "idle",
		lastEventAt: now - 5 * 60_000,
		startedAt: now - 10 * 60_000,
	});
	live.add(terminalId);
	return repo.getSessionByTerminal(db, terminalId) as AgentSession;
}

/** Whether a long-poll has answered by the time pending callbacks ran. */
async function answered(p: Promise<unknown>): Promise<boolean> {
	let done = false;
	void p.then(() => {
		done = true;
	});
	await flush();
	return done;
}

function deliveredVia(taskId: string): (string | null)[] {
	return db
		.select()
		.from(schema.peerMessages)
		.all()
		.filter((m) => m.toTaskId === taskId)
		.map((m) => m.deliveredVia);
}

describe("The user's own words to a Claude conversation", () => {
	it("go to its mod, held until it acks that the prompt went in", async () => {
		const b = addTask("b", "claude");
		addConversation(b, "tb");
		const hook = messenger.wait("tb");
		const mod = messenger.waitUser("tb");
		const r = messenger.sendFrom("user", { to: b.id, body: "Build as proposed" });
		expect(r.reason).toContain("delivered to its agent now");
		const out = await mod.result;
		expect(out.kind).toBe("message");
		if (out.kind !== "message") return;
		expect(out.text).toContain("Message from the user");
		expect(out.text).toContain("Build as proposed");
		// Never through the asyncRewake hook, whose output Claude frames as not the user's.
		expect(await answered(hook.result)).toBe(false);
		// Leased, not delivered: still pending, and not handed out twice.
		expect(repo.listPendingPeerMessages(db, b.id)).toHaveLength(1);
		const again = messenger.waitUser("tb");
		expect(await answered(again.result)).toBe(false);
		expect(messenger.ackUser("tb", out.deliveryId, true)).toBe(true);
		expect(repo.listPendingPeerMessages(db, b.id)).toHaveLength(0);
		expect(deliveredVia(b.id)).toEqual(["mod"]);
		hook.cancel();
		again.cancel();
	});

	it("go apart from agents' messages, which keep the hook door", async () => {
		const a = addTask("a");
		const b = addTask("b", "claude");
		addSession(a, "claude", "ta");
		addConversation(b, "tb");
		const hook = messenger.wait("tb");
		const mod = messenger.waitUser("tb");
		messenger.send({ fromTerminalId: "ta", to: b.id, body: "my branch touches yours" });
		messenger.sendFrom("user", { to: b.id, body: "go ahead" });
		const fromAgent = await hook.result;
		const fromUser = await mod.result;
		if (fromAgent.kind !== "message" || fromUser.kind !== "message") throw new Error("both answer");
		expect(fromAgent.text).toContain("my branch touches yours");
		expect(fromAgent.text).not.toContain("go ahead");
		expect(fromUser.text).toContain("go ahead");
		expect(fromUser.text).not.toContain("my branch touches yours");
	});

	it("wait for the turn to end after an Esc dropped them, then go again", async () => {
		const b = addTask("b", "claude");
		addConversation(b, "tb");
		const first = messenger.waitUser("tb");
		messenger.sendFrom("user", { to: b.id, body: "yes" });
		const out = await first.result;
		if (out.kind !== "message") throw new Error("expected a batch");
		expect(messenger.ackUser("tb", out.deliveryId, false)).toBe(true);
		expect(repo.listPendingPeerMessages(db, b.id)).toHaveLength(1);
		// Offered again at once, Claude would drop it again: held until a Stop.
		const held = messenger.waitUser("tb");
		expect(await answered(held.result)).toBe(false);
		messenger.kick(b.id);
		const retried = await held.result;
		expect(retried.kind).toBe("message");
	});

	it("are offered again once a lease runs out without an ack", async () => {
		const b = addTask("b", "claude");
		addConversation(b, "tb");
		const first = messenger.waitUser("tb");
		messenger.sendFrom("user", { to: b.id, body: "yes" });
		expect((await first.result).kind).toBe("message");
		now += MOD_LEASE_MS + 1;
		expect((await messenger.waitUser("tb").result).kind).toBe("message");
	});

	it("restart an idle conversation whose mod is not there, as its prompt", async () => {
		const b = addTask("b", "claude");
		addConversation(b, "tb");
		messenger.wait("tb"); // its hook listens, and must not get them
		now += MOD_GRACE_MS + 1;
		const r = messenger.sendFrom("user", { to: b.id, body: "Build as proposed" });
		expect(r.reason).toContain("resuming its conversation");
		await flush();
		await flush();
		expect(stopped).toEqual(["tb"]);
		expect(launched[0]?.prompt).toContain("Build as proposed");
		expect(deliveredVia(b.id)).toEqual(["launch"]);
	});

	it("wait for a mod still expected rather than restart under it", async () => {
		const b = addTask("b", "claude");
		addConversation(b, "tb");
		// The engine has only just started: mods are still reconnecting.
		expect(messenger.sendFrom("user", { to: b.id, body: "x" }).reason).toContain("queued");
		// Later, a mod that polled a moment ago is between two calls.
		now += MOD_GRACE_MS + 1;
		messenger.waitUser("tb").cancel();
		messenger.kick(b.id);
		await flush();
		expect(stopped).toHaveLength(0);
		expect(launched).toHaveLength(0);
	});

	it("go out with the launch when the terminal holding them is gone", async () => {
		const b = addTask("b", "claude");
		addConversation(b, "tb");
		const first = messenger.waitUser("tb");
		messenger.sendFrom("user", { to: b.id, body: "yes, merge it" });
		expect((await first.result).kind).toBe("message");
		live.delete("tb");
		messenger.kick(b.id);
		await flush();
		await flush();
		expect(launched[0]?.prompt).toContain("yes, merge it");
	});

	it("leave an agents board (no conversation id) on the hook door", async () => {
		const b = addTask("b", "claude");
		addSession(b, "claude", "tb");
		const hook = messenger.wait("tb");
		messenger.sendFrom("user", { to: b.id, body: "hello" });
		expect((await hook.result).kind).toBe("message");
	});

	// A mod polls only from its session's start: told "gone", it would be dead
	// for the next engine, and every later answer would cost a restart.
	it("tell a waiting mod to ask again when the engine stops", async () => {
		const b = addTask("b", "claude");
		addConversation(b, "tb");
		const mod = messenger.waitUser("tb");
		const hook = messenger.wait("tb");
		messenger.stop();
		expect((await mod.result).kind).toBe("timeout");
		expect((await hook.result).kind).toBe("gone");
	});

	it("refuse an ack for a lease the terminal does not hold", async () => {
		const b = addTask("b", "claude");
		addConversation(b, "tb");
		const first = messenger.waitUser("tb");
		messenger.sendFrom("user", { to: b.id, body: "yes" });
		const out = await first.result;
		if (out.kind !== "message") throw new Error("expected a batch");
		expect(messenger.ackUser("tx", out.deliveryId, true)).toBe(false);
		expect(messenger.ackUser("tb", "no-such-lease", true)).toBe(false);
		expect(repo.listPendingPeerMessages(db, b.id)).toHaveLength(1);
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

// What Claude Code 2.1.318 printed into its terminal for `claude --continue "…"`
// in a folder with no conversation, captured raw with script(1).
const NO_CONVERSATION =
	"\u001b7\u001b[r\u001b8\u001b[?25h\u001b[38;5;211mNo conversation found to continue\u001b[39m\r\r\n\u001b[?25h\u001b(B\u000f\u001b[?1016l\u001b[?1006l\u001b[?1003l\u001b[?1002l\u001b[?1000l\u001b[>4m\u001b[?1004l\u001b[?2031l\u001b[?2004l\u001b[<u\u001b[?25h\u001b7\u001b[r\u001b8\u001b[?25h\u001b[?25h";

const allMessages = () => db.select().from(schema.peerMessages).all();

describe("terminalTail", () => {
	it("reads what an agent printed as it quit, without its terminal codes", () => {
		expect(terminalTail(NO_CONVERSATION)).toBe("No conversation found to continue");
	});

	it("keeps the last lines, and nothing for a terminal that said nothing", () => {
		expect(terminalTail("one\r\ntwo\r\n\r\nthree\nfour\n", 2)).toBe("three / four");
		expect(terminalTail("\u001b[?25h\u001b[2J")).toBe("");
	});
});

describe("A message whose woken agent never reads it", () => {
	it("tells the sending task when that agent quits before showing up", async () => {
		const a = addTask("a");
		addSession(a, "claude", "ta");
		const b = addTask("b", "claude");
		const sent = messenger.send({ fromTerminalId: "ta", to: b.id, body: "what did you do?\nmore" });
		expect(sent.reason).toContain("Ateam tells you");
		await flush();
		expect(launched).toHaveLength(1);

		messenger.agentOutput("launched-1", NO_CONVERSATION);
		now += 2_000;
		messenger.agentQuit("launched-1");

		const original = allMessages().find((m) => m.toTaskId === b.id);
		expect(original?.error).toContain(
			"quit 2 s after Ateam started it, before it reported starting up",
		);
		expect(original?.error).toContain("No conversation found to continue");
		expect(repo.listPendingPeerMessages(db, b.id)).toHaveLength(0);

		const notice = repo.listPendingPeerMessages(db, a.id);
		expect(notice).toHaveLength(1);
		expect(notice[0]?.fromTerminalId).toBe(NOTICE_SENDER);
		const { result } = messenger.wait("ta");
		const got = await result;
		expect(got.kind).toBe("message");
		const text = got.kind === "message" ? got.text : "";
		expect(text).toContain("[Ateam] Notice from Ateam itself");
		expect(text).toContain(`Your message to "b" (task id ${b.id}) that begins "what did you do?"`);
		expect(text).toContain("No conversation found to continue");
		expect(text).toContain("No answer to it will come");
	});

	it("leaves an agent that showed up alone, whenever it quits", async () => {
		const a = addTask("a");
		addSession(a, "claude", "ta");
		const b = addTask("b", "claude");
		messenger.send({ fromTerminalId: "ta", to: b.id, body: "hi" });
		await flush();
		messenger.agentEvent("launched-1");
		messenger.agentQuit("launched-1");
		expect(allMessages()).toHaveLength(1);
		expect(allMessages()[0]?.error).toBeNull();
		expect(allMessages()[0]?.deliveredVia).toBe("launch");
	});

	it("fails a batch once when its agent cannot be started, instead of retrying it unseen", async () => {
		let tries = 0;
		messenger = new PeerMessenger({
			db,
			isLive: (t) => live.has(t),
			lastInputAt: () => null,
			stopSession: async () => {},
			launch: async () => {
				tries++;
				throw new Error("Claude Code isn't installed here");
			},
			log: () => {},
			now: () => now,
		});
		const a = addTask("a");
		addSession(a, "claude", "ta");
		const b = addTask("b", "claude");
		messenger.send({ fromTerminalId: "ta", to: b.id, body: "hi" });
		await flush();
		messenger.sweep();
		await flush();
		expect(tries).toBe(1);
		const original = allMessages().find((m) => m.toTaskId === b.id);
		expect(original?.deliveredAt).not.toBeNull();
		expect(original?.error).toContain("Claude Code isn't installed here");
		expect(repo.listPendingPeerMessages(db, a.id)[0]?.body).toContain(
			"Ateam could not start its agent",
		);
	});

	it("leaves the batch pending for a launch already bringing the conversation back", async () => {
		messenger = new PeerMessenger({
			db,
			isLive: (t) => live.has(t),
			lastInputAt: () => null,
			stopSession: async () => {},
			launch: async () => null,
			log: () => {},
			now: () => now,
		});
		const a = addTask("a");
		addSession(a, "claude", "ta");
		const b = addTask("b", "claude");
		messenger.send({ fromTerminalId: "ta", to: b.id, body: "hi" });
		await flush();
		expect(repo.listPendingPeerMessages(db, b.id)).toHaveLength(1);
		expect(allMessages()).toHaveLength(1);
	});

	it("never answers a notice that did not get through with another", async () => {
		const a = addTask("a", "claude");
		addSession(a, "claude", "ta");
		live.delete("ta"); // the sender has stopped since
		const b = addTask("b", "claude");
		messenger.send({ fromTerminalId: "ta", to: b.id, body: "hi" });
		await flush();
		messenger.agentQuit("launched-1");
		await flush();
		expect(launched.map((l) => l.taskId)).toEqual([b.id, a.id]);
		messenger.agentQuit("launched-2");
		await flush();
		const rows = allMessages();
		expect(rows).toHaveLength(2);
		expect(rows.every((m) => m.error)).toBe(true);
		expect(launched).toHaveLength(2);
	});

	it("records why for a message from the Lead, which has no inbox to tell", async () => {
		const lines: string[] = [];
		messenger = new PeerMessenger({
			db,
			isLive: (t) => live.has(t),
			lastInputAt: () => null,
			stopSession: async () => {},
			launch: async () => ({ terminalId: "launched-1" }),
			log: (l) => lines.push(l),
			now: () => now,
		});
		const b = addTask("b", "claude");
		messenger.sendFrom("lead", { to: b.id, body: "please rebase" });
		await flush();
		messenger.agentQuit("launched-1");
		expect(allMessages()).toHaveLength(1);
		expect(allMessages()[0]?.error).toContain("quit");
		expect(lines.some((l) => l.includes(b.id))).toBe(true);
	});

	it("counts a listener asking for messages as the agent being up (OpenCode has no hooks)", async () => {
		const a = addTask("a");
		addSession(a, "claude", "ta");
		const b = addTask("b", "opencode");
		messenger.send({ fromTerminalId: "ta", to: b.id, body: "hi" });
		await flush();
		addSession(b, "opencode", "launched-1");
		messenger.wait("launched-1");
		messenger.agentQuit("launched-1");
		expect(allMessages()).toHaveLength(1);
		expect(allMessages()[0]?.error).toBeNull();
	});

	it("does not report an agent that quits after the watch, sweep or not", async () => {
		const a = addTask("a");
		addSession(a, "claude", "ta");
		const b = addTask("b", "codex");
		messenger.send({ fromTerminalId: "ta", to: b.id, body: "hi" });
		await flush();
		now += STARTING_WATCH_MS + 1;
		messenger.agentQuit("launched-1");
		expect(allMessages()).toHaveLength(1);
		expect(allMessages()[0]?.error).toBeNull();
	});

	it("tells the sender an agent still unseen after the watch may be held at a prompt", async () => {
		const a = addTask("a");
		addSession(a, "claude", "ta");
		const b = addTask("b", "claude");
		messenger.send({ fromTerminalId: "ta", to: b.id, body: "what did you do?" });
		await flush();
		live.add("launched-1"); // still running, at a trust dialog say
		now += STARTING_WATCH_MS + 1;
		messenger.sweep();
		const original = allMessages().find((m) => m.toTaskId === b.id);
		expect(original?.error).toBeNull();
		expect(original?.deliveredVia).toBe("launch");
		const notice = repo.listPendingPeerMessages(db, a.id);
		expect(notice).toHaveLength(1);
		expect(notice[0]?.body).toContain("has not reached its agent yet");
		expect(notice[0]?.body).toContain("An answer may still come");
		// Told once: neither a later sweep nor its quitting tells again.
		messenger.sweep();
		messenger.agentQuit("launched-1");
		expect(allMessages()).toHaveLength(2);
	});

	it("lets go of a started agent whose terminal is gone without a word", async () => {
		const a = addTask("a");
		addSession(a, "claude", "ta");
		const b = addTask("b", "claude");
		messenger.send({ fromTerminalId: "ta", to: b.id, body: "hi" });
		await flush();
		now += STARTING_WATCH_MS + 1;
		messenger.sweep();
		messenger.agentQuit("launched-1");
		expect(allMessages()).toHaveLength(1);
		expect(allMessages()[0]?.error).toBeNull();
	});
});
