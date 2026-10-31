import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AteamDb } from "@ateam/db";
import { bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import { peerToken } from "../src/agent-setup";
import { FollowUps } from "../src/follow-ups";
import { BOARD_INSTRUCTIONS } from "../src/hooks/board-mcp";
import type { Services } from "../src/services";
import { spawnAgentInTask } from "../src/sessions";
import { WorktreeGuard } from "../src/worktree-guard";

// Opening a stopped task auto-resumes its conversation, so a resume must be
// side-effect free on the board: the card keeps its column, status and "last
// activity" until the user actually types. Driven through the real spawn path
// with a PTY client that records instead of forking.

function createTestDb(): AteamDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	bootstrap(sqlite);
	return drizzle(sqlite, { schema }) as unknown as AteamDb;
}

// The no-bypass guard every Claude launch carries (agents registry `guardFlag`).
const G = `--settings '{"permissions":{"disableBypassPermissionsMode":"disable"}}'`;

let db: AteamDb;
let services: Services;
let taskId: string;
let spawned: { command: string; cwd: string } | null;
let launches: { args: string[] }[];
const T0 = 1_700_000_000_000;

beforeEach(() => {
	db = createTestDb();
	spawned = null;
	const scratch = mkdtempSync(join(tmpdir(), "ateam-spawn-"));
	launches = [];
	services = {
		db,
		pty: {
			// `args` is `["-l", "-c", "<agent cmd>; exec <shell> -l"]`.
			spawn: (o: { args: string[]; cwd: string }) => {
				spawned = { command: o.args[2] ?? "", cwd: o.cwd };
				launches.push(o);
				return "pty";
			},
			has: () => false,
		},
		hooksDir: scratch,
		notifyScriptPath: join(scratch, "notify.sh"),
		peerSecret: "test-secret",
		hookPort: 0,
		followUps: new FollowUps(),
		pendingSeeds: new Map(),
		worktreeGuard: new WorktreeGuard(),
		// The launch refuses when the agent's CLI is missing (sessions.ts), and a
		// CI runner has no agent CLIs at all. Stub it: this file is about what a
		// resume does to the card, not about what is installed on the machine.
		probeAgent: async () => "present" as const,
		refreshPath: async () => false,
		// Overridden per-test. Defaults to "asked, nothing here", which is what an
		// agent with no conversation in this worktree looks like.
		latestSession: async () => ({ ok: true, id: null }),
	} as unknown as Services;
	const project = repo.upsertProject(db, {
		repoPath: "/tmp/repo",
		name: "Repo",
		defaultBranch: "main",
	});
	if (!project) throw new Error("failed to seed project");
	const task = repo.createTask(db, {
		projectId: project.id,
		name: "stopped task",
		slug: "stopped-task",
		branch: "feat/stopped",
		baseBranch: "main",
		worktreePath: scratch,
	});
	// The card as a stopped agent leaves it: parked on a question, last heard
	// from at T0.
	repo.updateTask(db, task.id, {
		column: "needs_attention",
		agentStatus: "stopped",
		lastEventAt: T0,
	});
	taskId = task.id;
});

describe("the launch line", () => {
	it("reports the agent's exit before the pane falls back to a shell", async () => {
		await spawnAgentInTask(services, () => {}, { taskId, agentId: "claude" });
		const notify = services.notifyScriptPath;
		expect(spawned?.command).toMatch(new RegExp(`; sh '${notify}' AgentExit; exec \\S+ -l$`));
	});
});

// Fly's Sprite image defaults Claude to bypassPermissions, which made a task
// launched with Auto off skip every check while Auto on still had auto mode's.
describe("the no-bypass guard on the launch line", () => {
	it("Auto off carries it and leaves the mode to the user's settings", async () => {
		await spawnAgentInTask(services, () => {}, { taskId, agentId: "claude", prompt: "go" });
		expect(spawned?.command).toStartWith(`claude ${G} --session-id `);
		expect(spawned?.command).not.toInclude("--permission-mode");
	});

	it("Auto on carries it next to auto mode", async () => {
		await spawnAgentInTask(services, () => {}, {
			taskId,
			agentId: "claude",
			prompt: "go",
			yolo: true,
		});
		expect(spawned?.command).toStartWith(`claude --permission-mode auto ${G} `);
	});

	it("a resume carries it too", async () => {
		await spawnAgentInTask(services, () => {}, { taskId, agentId: "claude", resume: true });
		expect(spawned?.command).toStartWith(`claude --continue ${G}`);
	});
});

describe("spawnAgentInTask on resume", () => {
	it("`--continue` leaves column, status and last activity untouched", async () => {
		await spawnAgentInTask(services, () => {}, { taskId, agentId: "claude", resume: true });
		const task = repo.getTask(db, taskId);
		expect(task).toMatchObject({
			column: "needs_attention",
			agentStatus: "stopped",
			lastEventAt: T0,
			agentId: "claude",
		});
	});

	it("resuming a specific conversation leaves the card where it was too", async () => {
		await spawnAgentInTask(services, () => {}, {
			taskId,
			agentId: "claude",
			resumeSessionId: "11111111-1111-4111-8111-111111111111",
		});
		const task = repo.getTask(db, taskId);
		expect(task).toMatchObject({
			column: "needs_attention",
			agentStatus: "stopped",
			lastEventAt: T0,
		});
	});

	it("a launch that carries a prompt still files the card as running", async () => {
		await spawnAgentInTask(services, () => {}, {
			taskId,
			agentId: "claude",
			prompt: "fix the bug",
		});
		const task = repo.getTask(db, taskId);
		expect(task).toMatchObject({ column: "running", agentStatus: "running", lastEventAt: T0 });
	});

	it("a resumed session sits idle, so it doesn't hold its box awake; a prompted one runs", async () => {
		// The box's sleep control reads session rows (Engine.isWorking): a resume
		// filed as running kept the box up for as long as the idle pane lived.
		await spawnAgentInTask(services, () => {}, { taskId, agentId: "claude", resume: true });
		await spawnAgentInTask(services, () => {}, {
			taskId,
			agentId: "claude",
			prompt: "fix the bug",
		});
		expect(repo.listOpenSessions(db).map((s) => s.status)).toEqual(["idle", "running"]);
	});
});

// OpenCode files its conversations by project, and every git worktree of a repo
// is one project to it — so `opencode --continue` in this task's worktree
// reopens whichever task in the repo ran last. A resume has to name the id.
describe("resuming an agent whose --continue reaches beyond the worktree", () => {
	it("resumes THIS worktree's newest conversation by id", async () => {
		services.latestSession = async () => ({ ok: true, id: "ses_here" });
		await spawnAgentInTask(services, () => {}, { taskId, agentId: "opencode", resume: true });
		expect(spawned?.command).toStartWith("opencode --session 'ses_here'");
		expect(spawned?.command).not.toInclude("--continue");
	});

	it("records the id, so the next restore skips the scan", async () => {
		services.latestSession = async () => ({ ok: true, id: "ses_here" });
		await spawnAgentInTask(services, () => {}, { taskId, agentId: "opencode", resume: true });
		expect(repo.listSessionsByTask(db, taskId)[0]).toMatchObject({
			agentSessionId: "ses_here",
		});
	});

	it("starts fresh when this worktree has no conversation yet", async () => {
		await spawnAgentInTask(services, () => {}, { taskId, agentId: "opencode", resume: true });
		expect(spawned?.command).toStartWith("opencode;");
	});

	it("falls back to --continue when the scan itself failed", async () => {
		services.latestSession = async () => ({ ok: false, id: null });
		await spawnAgentInTask(services, () => {}, { taskId, agentId: "opencode", resume: true });
		expect(spawned?.command).toStartWith("opencode --continue");
	});

	it("leaves an agent whose --continue is cwd-scoped alone", async () => {
		let scanned = false;
		services.latestSession = async () => {
			scanned = true;
			return { ok: true, id: "ses_here" };
		};
		await spawnAgentInTask(services, () => {}, { taskId, agentId: "claude", resume: true });
		expect(scanned).toBe(false);
		expect(spawned?.command).toStartWith("claude --continue");
	});

	// `codex resume --last` reopened a sibling worktree's newer thread.
	it("resumes THIS worktree's Codex thread by id, not --last", async () => {
		services.latestSession = async () => ({ ok: true, id: "01a12665-here" });
		await spawnAgentInTask(services, () => {}, { taskId, agentId: "codex", resume: true });
		// Ateam slots its `-c notify=…` hook between `codex` and the subcommand.
		expect(spawned?.command).toMatch(/^codex .* resume '01a12665-here';/);
		expect(spawned?.command).not.toInclude("--last");
	});

	it("falls back to codex resume --last when the thread index can't be read", async () => {
		services.latestSession = async () => ({ ok: false, id: null });
		await spawnAgentInTask(services, () => {}, { taskId, agentId: "codex", resume: true });
		expect(spawned?.command).toMatch(/^codex .* resume --last;/);
	});
});

describe("spawnAgentInTask and a task parked on an outside party", () => {
	const WAIT = { waitingReason: "Twilio approval", waitingUntil: T0 + 5 * 86_400_000 };

	it("a resume keeps the wait — opening a stopped task is looking, not acting", async () => {
		repo.updateTask(db, taskId, WAIT);
		await spawnAgentInTask(services, () => {}, { taskId, agentId: "claude", resume: true });
		expect(repo.getTask(db, taskId)).toMatchObject(WAIT);
	});

	it("a fresh launch keeps a pending wait: it is about the outside party, not the user", async () => {
		repo.updateTask(db, taskId, WAIT);
		await spawnAgentInTask(services, () => {}, { taskId, agentId: "claude", prompt: "carry on" });
		expect(repo.getTask(db, taskId)).toMatchObject(WAIT);
	});

	it("a fresh launch ends a wait that already resurfaced, and says so", async () => {
		repo.updateTask(db, taskId, { ...WAIT, waitingFiredAt: T0 });
		const updated: string[] = [];
		await spawnAgentInTask(services, (id) => updated.push(id), {
			taskId,
			agentId: "claude",
			prompt: "carry on",
		});
		expect(repo.getTask(db, taskId)).toMatchObject({
			waitingReason: null,
			waitingUntil: null,
			waitingFiredAt: null,
		});
		expect(updated).toContain(taskId);
	});

	it("a claude launch carries the board MCP, after the prompt so nothing is swallowed", async () => {
		await spawnAgentInTask(services, () => {}, { taskId, agentId: "claude", prompt: "hi there" });
		const command = launches[0]?.args.at(-1) ?? "";
		const mcp = command.indexOf("--mcp-config");
		expect(mcp).toBeGreaterThan(command.indexOf("'hi there'"));
		expect(command).toContain(
			"--allowedTools 'mcp__ateam_board__get_board,mcp__ateam_board__set_status,mcp__ateam_board__set_waiting,mcp__ateam_board__list_peers,mcp__ateam_board__send_message,mcp__ateam_board__ask_user,mcp__ateam_board__show_page'",
		);
		// The config file names this terminal, which is how set_waiting knows whose card it is.
		const file = /--mcp-config '([^']+)'/.exec(command)?.[1] ?? "";
		const cfg = JSON.parse(readFileSync(file, "utf8"));
		const terminalId = cfg.mcpServers.ateam_board.headers["x-ateam-terminal-id"];
		expect(terminalId).toHaveLength(36);
		// ...and proves it with the terminal's own token, the one in its env.
		expect(cfg.mcpServers.ateam_board.headers["x-ateam-terminal-token"]).toBe(
			peerToken("test-secret", terminalId),
		);
	});
});

describe("peer messaging on the launch line", () => {
	const envOf = () => (launches[0] as unknown as { env: NodeJS.ProcessEnv }).env;

	it("every agent's env carries its terminal token", async () => {
		await spawnAgentInTask(services, () => {}, { taskId, agentId: "codex" });
		const env = envOf();
		expect(env.ATEAM_TERMINAL_TOKEN).toBe(peerToken("test-secret", env.ATEAM_TERMINAL_ID ?? ""));
	});

	it("codex gets the board MCP per launch, its headers read from the env", async () => {
		await spawnAgentInTask(services, () => {}, { taskId, agentId: "codex", prompt: "go" });
		const command = launches[0]?.args.at(-1) ?? "";
		expect(command).toContain(`-c 'mcp_servers.ateam_board.url="http://127.0.0.1:0/mcp"'`);
		expect(command).toContain('"x-ateam-terminal-token"="ATEAM_TERMINAL_TOKEN"');
		expect(command).not.toContain(envOf().ATEAM_TERMINAL_TOKEN ?? "<none>");
		// Codex ignores MCP server instructions; it gets them as developer_instructions,
		// which must survive the shell and TOML quoting unescaped.
		expect(command).toContain(`-c 'developer_instructions="${BOARD_INSTRUCTIONS}"'`);
		expect(BOARD_INSTRUCTIONS).not.toMatch(/['"\\]/);
	});

	it("opencode gets the MCP server and the inbox plugin through its config env", async () => {
		await spawnAgentInTask(services, () => {}, { taskId, agentId: "opencode" });
		const cfg = JSON.parse(envOf().OPENCODE_CONFIG_CONTENT ?? "{}");
		expect(cfg.mcp.ateam_board.type).toBe("remote");
		expect(cfg.plugin.at(-1)).toContain("opencode-inbox.js");
	});

	// A peer message wakes a stopped task by resuming it WITH the message.
	it("a resume that carries a prompt is work starting, not a look", async () => {
		await spawnAgentInTask(services, () => {}, {
			taskId,
			agentId: "claude",
			resumeSessionId: "conv-1",
			prompt: "[Ateam] Message from ...",
		});
		expect(repo.getTask(db, taskId)).toMatchObject({ column: "running", agentStatus: "running" });
		expect(launches[0]?.args.at(-1)).toContain(
			`claude --resume 'conv-1' ${G} '[Ateam] Message from ...'`,
		);
		// The task's description stays what the user started it with.
		expect(repo.getTask(db, taskId)?.description ?? null).toBeNull();
	});
});
