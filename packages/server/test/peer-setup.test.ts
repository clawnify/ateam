import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ensureBoardMcpConfig,
	ensureClaudeHooks,
	ensureNotifyScript,
	ensurePeerSecret,
	opencodeConfigContent,
	peerToken,
	verifyPeerToken,
} from "../src/agent-setup";

/**
 * The shipped listener scripts and per-launch config: the REAL inbox.sh
 * Claude's asyncRewake hook runs, against a stub `/inbox/wait`, so these are
 * assertions about the file on disk, not a reimplementation of it.
 */

let dir: string;
let notifyPath: string;
let server: ReturnType<typeof Bun.serve>;
/** Status codes the stub answers in order; the last one repeats. */
let answers: { status: number; body?: string }[] = [];
let seen: { terminalId: string | null; token: string | null }[] = [];

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "ateam-peer-"));
	notifyPath = await ensureNotifyScript(dir);
	server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			seen.push({
				terminalId: url.searchParams.get("terminalId"),
				token: req.headers.get("x-ateam-terminal-token"),
			});
			const a = answers.length > 1 ? answers.shift() : answers[0];
			return new Response(a?.body ?? null, { status: a?.status ?? 410 });
		},
	});
});

afterAll(async () => {
	server.stop(true);
	await rm(dir, { recursive: true, force: true });
});

async function runInbox(env: Record<string, string> = {}) {
	seen = [];
	const proc = Bun.spawn(["sh", join(dir, "hooks", "inbox.sh")], {
		env: {
			...process.env,
			ATEAM_HOOK_PORT: String(server.port),
			ATEAM_TERMINAL_ID: "term-1",
			ATEAM_TERMINAL_TOKEN: "tok",
			...env,
		},
		stdin: new TextEncoder().encode('{"hook_event_name":"Stop"}'),
		stdout: "pipe",
		stderr: "pipe",
	});
	const code = await proc.exited;
	return { code, stderr: await new Response(proc.stderr).text() };
}

describe("inbox.sh (Claude's asyncRewake listener)", () => {
	test("a message wakes the agent: exit 2 with the text on stderr", async () => {
		answers = [{ status: 200, body: "[Ateam] Message from ...\n\nrebase on main" }];
		const r = await runInbox();
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("rebase on main");
		expect(seen[0]).toEqual({ terminalId: "term-1", token: "tok" });
	});

	test("an empty window asks again, then delivers", async () => {
		answers = [{ status: 204 }, { status: 204 }, { status: 200, body: "hi" }];
		const r = await runInbox();
		expect(r.code).toBe(2);
		expect(seen).toHaveLength(3);
	});

	test("replaced, gone or refused ends quietly without waking anything", async () => {
		for (const status of [409, 410, 401]) {
			answers = [{ status }];
			expect((await runInbox()).code).toBe(0);
		}
	});

	test("does nothing outside an Ateam terminal", async () => {
		answers = [{ status: 200, body: "x" }];
		const r = await runInbox({ ATEAM_TERMINAL_TOKEN: "" });
		expect(r.code).toBe(0);
		expect(seen).toHaveLength(0);
	});
});

describe("peer tokens", () => {
	test("the secret persists, owner-only, and tokens verify per terminal", async () => {
		const secret = await ensurePeerSecret(dir);
		expect(await ensurePeerSecret(dir)).toBe(secret);
		expect((await stat(join(dir, "hooks", "peer-secret"))).mode & 0o777).toBe(0o600);
		const t = peerToken(secret, "term-1");
		expect(verifyPeerToken(secret, "term-1", t)).toBe(true);
		expect(verifyPeerToken(secret, "term-2", t)).toBe(false);
		expect(verifyPeerToken(secret, "term-1", "short")).toBe(false);
	});

	test("Claude's MCP config carries the token and is owner-only", async () => {
		const file = await ensureBoardMcpConfig({
			hooksDir: join(dir, "hooks"),
			hookPort: 1234,
			terminalId: "term-1",
			token: "tok",
		});
		const cfg = JSON.parse(await readFile(file, "utf8"));
		expect(cfg.mcpServers.ateam_board.headers).toEqual({
			"x-ateam-terminal-id": "term-1",
			"x-ateam-terminal-token": "tok",
		});
		expect((await stat(file)).mode & 0o777).toBe(0o600);
	});
});

describe("per-launch agent config", () => {
	test("Claude gets the inbox listener at SessionStart and Stop, once", async () => {
		const wt = join(dir, "wt");
		await ensureClaudeHooks(wt, notifyPath);
		await ensureClaudeHooks(wt, notifyPath);
		const s = JSON.parse(await readFile(join(wt, ".claude", "settings.local.json"), "utf8"));
		for (const event of ["SessionStart", "Stop"]) {
			const inbox = s.hooks[event]
				.flatMap((e: { hooks: unknown[] }) => e.hooks)
				.filter((h: { command: string }) => h.command.includes("inbox.sh"));
			expect(inbox).toHaveLength(1);
			expect(inbox[0].asyncRewake).toBe(true);
		}
	});

	test("OpenCode's config adds the plugin and server over the user's own", () => {
		const hooksDir = "/Users/x/Library/Application Support/Ateam/hooks";
		const cfg = JSON.parse(
			opencodeConfigContent({
				hookPort: 4321,
				hooksDir,
				existing: JSON.stringify({
					plugin: ["mine"],
					mcp: { other: { type: "local" } },
					model: "m",
				}),
			}),
		);
		expect(cfg.model).toBe("m");
		expect(cfg.mcp.other).toEqual({ type: "local" });
		expect(cfg.mcp.ateam_board.url).toBe("http://127.0.0.1:4321/mcp");
		expect(cfg.mcp.ateam_board.headers["x-ateam-terminal-token"]).toBe(
			"{env:ATEAM_TERMINAL_TOKEN}",
		);
		expect(cfg.plugin[0]).toBe("mine");
		// The space in "Application Support" must survive as a file URL.
		expect(fileURLToPath(cfg.plugin[1])).toBe(join(hooksDir, "opencode-inbox.js"));
	});
});
