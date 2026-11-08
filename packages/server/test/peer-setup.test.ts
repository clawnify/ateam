import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	codexHookArgs,
	ensureBoardMcpConfig,
	ensureClaudeHooks,
	ensureNotifyScript,
	ensurePeerSecret,
	opencodeConfigContent,
	peerToken,
	removeAteamCodexHooks,
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

describe("Ateam's Claude mod", () => {
	test("is written beside the hooks, a plugin whose module submits as the user", async () => {
		const mod = join(dir, "hooks", "claude-mod");
		const manifest = JSON.parse(await readFile(join(mod, ".claude-plugin", "plugin.json"), "utf8"));
		expect(manifest.name).toBe("ateam-inbox");
		const hooks = JSON.parse(await readFile(join(mod, "hooks", "hooks.json"), "utf8"));
		expect(hooks.modules).toEqual(["./register.js"]);
		const module = await readFile(join(mod, "hooks", "register.js"), "utf8");
		expect(module).toContain("asUser: true");
		expect(module).toContain("/inbox/user");
	});

	// Every running Claude task watches this folder and reloads the mod on a change.
	test("an unchanged rewrite leaves the files alone", async () => {
		const file = join(dir, "hooks", "claude-mod", "hooks", "register.js");
		const before = (await stat(file)).mtimeMs;
		await new Promise((r) => setTimeout(r, 20));
		await ensureNotifyScript(dir);
		expect((await stat(file)).mtimeMs).toBe(before);
	});
});

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

	test("Claude reports browser tool calls as BrowserUse, once, beside Working", async () => {
		const wt = join(dir, "wt");
		await ensureClaudeHooks(wt, notifyPath);
		await ensureClaudeHooks(wt, notifyPath);
		const s = JSON.parse(await readFile(join(wt, ".claude", "settings.local.json"), "utf8"));
		const pre = s.hooks.PreToolUse as { matcher?: string; hooks: { command: string }[] }[];
		const browser = pre.filter((e) => e.hooks.some((h) => h.command.endsWith(" BrowserUse")));
		expect(browser).toEqual([
			{ matcher: "mcp__(taskwindow|desktop)__.*", hooks: [expect.anything()] },
		]);
		// Every tool call still reports Working, browser calls included.
		expect(
			pre.filter((e) => !e.matcher && e.hooks.some((h) => h.command.endsWith(" Working"))),
		).toHaveLength(1);
	});

	test("a worktree set up before the browser hook gains it", async () => {
		const wt = join(dir, "wt-old");
		const file = join(wt, ".claude", "settings.local.json");
		await mkdir(dirname(file), { recursive: true });
		const old = {
			hooks: {
				PreToolUse: [{ hooks: [{ type: "command", command: `sh "${notifyPath}" Working` }] }],
			},
		};
		await writeFile(file, JSON.stringify(old));
		await ensureClaudeHooks(wt, notifyPath);
		const s = JSON.parse(await readFile(file, "utf8"));
		expect(s.hooks.PreToolUse.map((e: { matcher?: string }) => e.matcher ?? null)).toEqual([
			null,
			"mcp__(taskwindow|desktop)__.*",
		]);
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

test("installed desktop control is configured for every task agent without granting viewer takeover", async () => {
	const { buildAgentEnv, codexBoardMcpArgs } = await import("../src/agent-setup");
	const desktop = { url: "http://127.0.0.1:6080/mcp", token: "agent-only-secret" };
	const opts = {
		desktop,
		hooksDir: join(dir, "hooks"),
		hookPort: 1234,
		terminalId: "desktop-test",
	};
	const file = await ensureBoardMcpConfig(opts);
	const claude = JSON.parse(await readFile(file, "utf8"));
	expect(claude.mcpServers.desktop).toEqual({
		type: "http",
		url: desktop.url,
		headers: { Authorization: "Bearer agent-only-secret" },
	});
	const codex = codexBoardMcpArgs(1234, desktop);
	expect(codex).toContain('mcp_servers.desktop.url="http://127.0.0.1:6080/mcp"');
	expect(codex).toContain('"Authorization"="ATEAM_DESKTOP_AUTH"');
	expect(codex).not.toContain(desktop.token);
	const env = buildAgentEnv({ ...opts, agentId: "opencode" });
	expect(env.ATEAM_DESKTOP_AUTH).toBe("Bearer agent-only-secret");
	expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}").mcp.desktop).toEqual({
		type: "remote",
		url: desktop.url,
		headers: { Authorization: "{env:ATEAM_DESKTOP_AUTH}" },
	});
	expect(codexBoardMcpArgs(1234)).not.toContain("mcp_servers.desktop");
});

test("an existing browser-only hook is upgraded in place", async () => {
	const wt = join(dir, "browser-hook-upgrade");
	const file = join(wt, ".claude", "settings.local.json");
	await mkdir(dirname(file), { recursive: true });
	await writeFile(
		file,
		JSON.stringify({
			hooks: {
				PreToolUse: [
					{
						matcher: "mcp__taskwindow__.*",
						hooks: [{ type: "command", command: `sh "${notifyPath}" BrowserUse` }],
					},
				],
			},
		}),
	);
	await ensureClaudeHooks(wt, notifyPath);
	const s = JSON.parse(await readFile(file, "utf8"));
	const browser = s.hooks.PreToolUse.filter((e: { hooks: { command: string }[] }) =>
		e.hooks.some((h) => h.command.endsWith(" BrowserUse")),
	);
	expect(browser).toHaveLength(1);
	expect(browser[0].matcher).toBe("mcp__(taskwindow|desktop)__.*");
});

test("OpenCode desktop calls send BrowserUse through the shipped plugin", async () => {
	const file = join(dir, "hooks", "opencode-inbox.js");
	const source = await readFile(file, "utf8");
	// Run the real emitted plugin in an isolated process: its inbox exits on 410.
	// The stub records the desktop notification separately from the inbox request.
	const paths: string[] = [];
	const endpoint = Bun.serve({
		port: 0,
		fetch: (req) => {
			paths.push(new URL(req.url).pathname + new URL(req.url).search);
			return new Response(null, { status: 410 });
		},
	});
	try {
		const probe = join(dir, "opencode-desktop-probe.mjs");
		await writeFile(
			probe,
			source +
				'\nconst hooks=await AteamInbox({client:{}}); await hooks["tool.execute.before"]({tool:"desktop_computer"}); await hooks["tool.execute.before"]({tool:"bash"});',
		);
		const child = Bun.spawn([process.execPath, probe], {
			env: {
				...process.env,
				ATEAM_HOOK_PORT: String(endpoint.port),
				ATEAM_TERMINAL_ID: "desktop-term",
				ATEAM_TERMINAL_TOKEN: "test",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await child.exited).toBe(0);
		expect(paths.filter((p) => p.includes("eventType=BrowserUse"))).toEqual([
			"/hook/complete?terminalId=desktop-term&eventType=BrowserUse",
		]);
	} finally {
		endpoint.stop(true);
	}
});

// Codex 0.165 loads a worktree's `.codex/hooks.json` only in a folder the user
// trusted, and asks again for every new worktree path; hooks given with `-c`
// are trusted once per machine (agent-setup, codexHookArgs).
describe("Codex hooks on the launch line", () => {
	/** What a real shell hands Codex: the `-c` values, split as `sh` splits them. */
	async function argv(args: string): Promise<string[]> {
		const proc = Bun.spawn(["sh", "-c", `printf '%s\\0' ${args}`], { stdout: "pipe" });
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		return out.split("\0").filter(Boolean);
	}

	test("each event runs notify.sh, as TOML Codex parses, whatever the path holds", async () => {
		const path = "/Users/o'neil/Library/Application Support/ateam/hooks/notify.sh";
		const values = (await argv(codexHookArgs(path))).filter((a) => a !== "-c");
		const parsed = Object.fromEntries(
			values.map((v) => {
				const eq = v.indexOf("=");
				const key = v.slice(0, eq).replace(/^hooks\./, "");
				return [key, (Bun.TOML.parse(`v = ${v.slice(eq + 1)}`) as { v: unknown }).v];
			}),
		);
		const hook = (event: string) => [
			{ hooks: [{ type: "command", command: `sh ${JSON.stringify(path)} ${event}` }] },
		];
		expect(parsed).toEqual({
			SessionStart: hook("Start"),
			Stop: hook("Stop"),
			PermissionRequest: hook("PermissionRequest"),
			PreToolUse: [
				...hook("Working"),
				{
					matcher: "mcp__desktop__.*",
					hooks: [{ type: "command", command: `sh ${JSON.stringify(path)} BrowserUse` }],
				},
			],
			UserPromptSubmit: hook("UserReply"),
		});
	});

	// Codex keys a hook's trust on its hash: any change asks every machine again.
	test("the commands never change between launches", () => {
		expect(codexHookArgs("/h/notify.sh")).toBe(codexHookArgs("/h/notify.sh"));
	});
});

describe("removeAteamCodexHooks", () => {
	const ours = (event: string) => ({
		hooks: [
			{
				type: "command",
				command: `sh "/Users/x/Library/Application Support/ateam/hooks/notify.sh" ${event}`,
			},
		],
	});

	test("removes a file and folder that held only Ateam's hooks", async () => {
		const wt = join(dir, "codex-only-ours");
		await mkdir(join(wt, ".codex"), { recursive: true });
		await writeFile(
			join(wt, ".codex", "hooks.json"),
			JSON.stringify({ hooks: { SessionStart: [ours("Start")], Stop: [ours("Stop")] } }),
		);
		await removeAteamCodexHooks(wt);
		expect(await stat(join(wt, ".codex")).catch(() => null)).toBeNull();
	});

	test("keeps the repo's own hooks and settings", async () => {
		const wt = join(dir, "codex-mixed");
		await mkdir(join(wt, ".codex"), { recursive: true });
		const theirs = { hooks: [{ type: "command", command: "sh ./scripts/notify.sh Stop" }] };
		await writeFile(
			join(wt, ".codex", "hooks.json"),
			JSON.stringify({
				description: "repo hooks",
				hooks: {
					Stop: [theirs, ours("Stop")],
					PreToolUse: [ours("Working"), { ...ours("BrowserUse"), matcher: "mcp__desktop__.*" }],
				},
			}),
		);
		await removeAteamCodexHooks(wt);
		const left = JSON.parse(await readFile(join(wt, ".codex", "hooks.json"), "utf8"));
		expect(left).toEqual({ description: "repo hooks", hooks: { Stop: [theirs] } });
	});

	test("leaves a folder with other files in it, and no file at all", async () => {
		const wt = join(dir, "codex-folder-kept");
		await mkdir(join(wt, ".codex"), { recursive: true });
		await writeFile(join(wt, ".codex", "config.toml"), "model = 'x'\n");
		await writeFile(
			join(wt, ".codex", "hooks.json"),
			JSON.stringify({ hooks: { Stop: [ours("Stop")] } }),
		);
		await removeAteamCodexHooks(wt);
		expect(await stat(join(wt, ".codex", "hooks.json")).catch(() => null)).toBeNull();
		expect(await readFile(join(wt, ".codex", "config.toml"), "utf8")).toBe("model = 'x'\n");
		await removeAteamCodexHooks(join(dir, "no-such-worktree"));
	});
});
