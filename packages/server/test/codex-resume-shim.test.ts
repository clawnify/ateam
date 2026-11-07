import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentEnv, ensureCodexResumeShim, ensureNotifyScript } from "../src/agent-setup";
import { type HookEvent, HookServer } from "../src/hooks/hook-server";

// Execute the shipped PATH shim and notify scripts against the real hook server.
// The CLI stand-in runs the SessionStart command it actually received via -c.
let dir: string;
let hooksDir: string;
let server: HookServer;
let events: HookEvent[] = [];

beforeAll(async () => {
	// Spaces and apostrophes exercise all three quoting layers (sh, TOML, JSON).
	dir = await mkdtemp(join(tmpdir(), "ateam codex's resume-"));
	hooksDir = join(dir, "hooks");
	await ensureNotifyScript(dir);
	server = new HookServer();
	server.on("hook", (e: HookEvent) => events.push(e));
	await server.start();
	await ensureCodexResumeShim(dir, server.port);
	const bin = join(dir, "bin");
	await mkdir(bin);
	const fake = join(bin, "codex");
	await writeFile(
		fake,
		`#!${process.execPath}
const args = process.argv.slice(2);
const configs = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "-c") continue;
  const raw = args[++i];
  const eq = raw.indexOf("=");
  configs[raw.slice(0, eq)] = Bun.TOML.parse("v=" + raw.slice(eq + 1)).v;
}
if (process.env.FIRE_HOOKS === "1") {
  const start = configs["hooks.SessionStart"]?.[0]?.hooks?.[0]?.command;
  if (!start) throw new Error("SessionStart hook missing");
  const hook = Bun.spawn(["sh", "-c", start], {
    stdin: new TextEncoder().encode(JSON.stringify({session_id: "resumed-thread"})),
    stdout: "inherit", stderr: "inherit",
  });
  if (await hook.exited) throw new Error("SessionStart hook failed");
}
console.log(JSON.stringify({args, configs, agentId: process.env.ATEAM_AGENT_ID}));
process.exit(Number(process.env.CODEX_EXIT ?? "0"));
`,
	);
	await chmod(fake, 0o755);
});

afterAll(async () => {
	server?.stop();
	if (dir) await rm(dir, { recursive: true, force: true });
});

async function run(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
	events = [];
	const env = buildAgentEnv({
		terminalId: "manual-tab",
		agentId: "shell",
		hookPort: server.port,
		hooksDir,
		token: "token",
	});
	const proc = Bun.spawn([join(hooksDir, "codex"), ...args], {
		env: {
			...env,
			PATH: `${hooksDir}:${join(dir, "bin")}:${process.env.PATH}`,
			ATEAM_CODEX_ACTIVE: "",
			...extraEnv,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;
	expect(stderr).toBe("");
	return { code, output: JSON.parse(stdout), events: [...events] };
}

describe("manual codex resume", () => {
	it("adds the launch configuration, reports the actual conversation, then reports exit", async () => {
		const result = await run(["resume", "thread-id", "a prompt with 'quotes' and $(literal)"], {
			FIRE_HOOKS: "1",
			CODEX_EXIT: "3",
		});
		expect(result.code).toBe(3);
		expect(result.output.args.slice(-3)).toEqual([
			"resume",
			"thread-id",
			"a prompt with 'quotes' and $(literal)",
		]);
		expect(result.output.configs.notify).toEqual(["sh", join(hooksDir, "codex-notify.sh")]);
		expect(result.output.configs["mcp_servers.ateam_board.url"]).toBe(
			`http://127.0.0.1:${server.port}/mcp`,
		);
		expect(result.events).toMatchObject([
			{ eventType: "Start", agentId: "codex", terminalId: "manual-tab" },
			{
				eventType: "Start",
				agentId: "codex",
				sessionId: "resumed-thread",
				terminalId: "manual-tab",
			},
			{ eventType: "AgentExit", agentId: "codex", terminalId: "manual-tab" },
		]);
	});

	it("recognizes a resume by UUID immediately, even before Codex hooks are trusted", async () => {
		const id = "019A5EB8-1234-7000-8000-000000000001";
		const result = await run(["resume", id]);
		expect(result.events).toMatchObject([
			{ eventType: "Start", agentId: "codex", sessionId: id.toLowerCase() },
			{ eventType: "AgentExit" },
		]);
	});

	it("lets Codex resolve flags and names without treating them as conversation UUIDs", async () => {
		for (const name of ["--last", "my session", 'quotes"$(literal)']) {
			const result = await run(["resume", name]);
			expect(result.output.args.slice(-2)).toEqual(["resume", name]);
			expect(result.events[0]).toMatchObject({ eventType: "Start", agentId: "codex" });
			expect(result.events[0]?.sessionId).toBeUndefined();
		}
	});

	it("passes help, headless commands, and Ateam's already-configured launch through", async () => {
		for (const args of [
			["resume", "--help"],
			["exec", "a prompt"],
			["-c", 'model="test"', "resume", "id"],
		]) {
			const result = await run(args);
			expect(result.output.args).toEqual(args);
			expect(result.events).toEqual([]);
		}
	});

	it("does not let a nested resume claim its parent's tab", async () => {
		const result = await run(["resume", "child-thread"], { ATEAM_CODEX_ACTIVE: "1" });
		expect(result.output.args).toEqual(["resume", "child-thread"]);
		expect(result.events).toEqual([]);
	});
});
