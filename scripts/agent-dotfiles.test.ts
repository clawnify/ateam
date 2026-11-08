import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
	appendFile,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Dotfiles } from "../packages/server/src/dotfiles";

const exec = promisify(execFile);
const starter = resolve(import.meta.dir, "../examples/agent-dotfiles");
const instructions = [".claude/CLAUDE.md", ".codex/AGENTS.md", ".config/opencode/AGENTS.md"];
const skill = ".agents/skills/review-changes/SKILL.md";
const chezmoi = Bun.which("chezmoi");
if (!chezmoi && process.env.REQUIRE_CHEZMOI_TESTS)
	throw new Error("Install chezmoi 2.74.0+ to run the starter checks.");

// Optional locally; the dedicated workflow requires the real pinned binary.
describe.skipIf(!chezmoi)("agent dotfiles starter (real chezmoi)", () => {
	let root: string;
	let sequence = 0;
	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "agent-dotfiles-"));
	});
	afterAll(async () => {
		if (root) await rm(root, { recursive: true, force: true });
	});

	async function fixture(sourceName = "source with spaces") {
		const dir = join(root, String(++sequence));
		const source = join(dir, sourceName);
		const destination = join(dir, "home with spaces");
		await mkdir(destination, { recursive: true });
		await cp(starter, source, { recursive: true });
		const run = (...args: string[]) =>
			exec(join(source, "install.sh"), ["--destination", destination, ...args], {
				timeout: 15_000,
			});
		return { dir, source, destination, run };
	}

	it("checks without writing, installs native paths, preserves credentials, and reapplies without changes", async () => {
		const f = await fixture();
		await mkdir(join(f.destination, ".codex"));
		await writeFile(join(f.destination, ".codex/auth.json"), "existing credentials sentinel");
		expect((await f.run("--check")).stdout).toContain("no agent files changed");
		for (const file of [...instructions, skill])
			expect(existsSync(join(f.destination, file))).toBe(false);
		await f.run();
		const canonical = await readFile(
			join(f.source, "home/.chezmoitemplates/instructions.md"),
			"utf8",
		);
		for (const file of instructions)
			expect((await readFile(join(f.destination, file), "utf8")).trim()).toBe(canonical.trim());
		expect(await readlink(join(f.destination, ".claude/skills/review-changes"))).toBe(
			"../../.agents/skills/review-changes",
		);
		expect(
			await readFile(join(f.destination, ".claude/skills/review-changes/SKILL.md"), "utf8"),
		).toBe(await readFile(join(f.destination, skill), "utf8"));
		const before = await stat(join(f.destination, ".codex/AGENTS.md"));
		expect((await f.run()).stdout).not.toContain("diff --git");
		expect((await stat(join(f.destination, ".codex/AGENTS.md"))).mtimeMs).toBe(before.mtimeMs);
		expect(await readFile(join(f.destination, ".codex/auth.json"), "utf8")).toBe(
			"existing credentials sentinel",
		);
		for (const file of [
			"install.sh",
			"README.md",
			".claude/settings.json",
			".codex/config.toml",
			".config/opencode/opencode.json",
		])
			expect(existsSync(join(f.destination, file))).toBe(false);
	});

	it("rejects unknown arguments and a missing installer dependency without writing agent files", async () => {
		const f = await fixture();
		await expect(f.run("--force")).rejects.toThrow();
		const restrictedPath = join(f.dir, "tools-without-chezmoi");
		await mkdir(restrictedPath);
		const dirname = Bun.which("dirname");
		if (!dirname) throw new Error("dirname is required by the installer");
		await symlink(dirname, join(restrictedPath, "dirname"));
		try {
			await exec(join(f.source, "install.sh"), ["--destination", f.destination], {
				env: { ...process.env, PATH: restrictedPath },
			});
			throw new Error("Expected missing chezmoi to fail");
		} catch (e) {
			expect((e as { stderr: string }).stderr).toContain("Install chezmoi 2.74.0");
		}
		expect(existsSync(join(f.destination, skill))).toBe(false);
	});

	it("refuses pre-existing instructions before writing any agent files", async () => {
		const f = await fixture();
		await mkdir(join(f.destination, ".config/opencode"), { recursive: true });
		const occupied = join(f.destination, ".config/opencode/AGENTS.md");
		await writeFile(occupied, "Keep my instructions");
		await expect(f.run()).rejects.toThrow();
		expect(await readFile(occupied, "utf8")).toBe("Keep my instructions");
		expect(existsSync(join(f.destination, skill))).toBe(false);
		expect(existsSync(join(f.destination, ".claude/CLAUDE.md"))).toBe(false);
	});

	it("updates clean managed instructions, then refuses local edits without partially updating other files", async () => {
		const f = await fixture();
		await f.run();
		const source = join(f.source, "home/.chezmoitemplates/instructions.md");
		await appendFile(source, "\n- Prefer small reviewable changes.\n");
		await f.run();
		for (const file of instructions)
			expect(await readFile(join(f.destination, file), "utf8")).toContain(
				"Prefer small reviewable changes",
			);
		await writeFile(join(f.destination, ".codex/AGENTS.md"), "My local edit");
		await appendFile(source, "\n- This update must wait for reconciliation.\n");
		await expect(f.run()).rejects.toThrow();
		expect(await readFile(join(f.destination, ".codex/AGENTS.md"), "utf8")).toBe("My local edit");
		expect(await readFile(join(f.destination, ".claude/CLAUDE.md"), "utf8")).not.toContain(
			"must wait",
		);
	});

	it("refuses an existing agent-directory symlink and preserves its target", async () => {
		const f = await fixture();
		const outside = join(f.dir, "existing setup");
		await mkdir(outside);
		await writeFile(join(outside, "CLAUDE.md"), "Keep the linked setup");
		await symlink(outside, join(f.destination, ".claude"));
		await expect(f.run()).rejects.toThrow();
		expect(await readlink(join(f.destination, ".claude"))).toBe(outside);
		expect(await readFile(join(outside, "CLAUDE.md"), "utf8")).toBe("Keep the linked setup");
		expect(existsSync(join(f.destination, skill))).toBe(false);
	});

	it("runs the actual starter through Ateam clone, Preview, Apply and reapply", async () => {
		const f = await fixture("repo");
		// The manager gives the installer a disposable HOME. Runner-specific agent
		// directories still point outside it, so clear them only in this fixture's
		// subprocess before invoking the unchanged real installer.
		await writeFile(
			join(f.source, "test-install.sh"),
			"#!/bin/sh\nunset CODEX_HOME CLAUDE_CONFIG_DIR XDG_CONFIG_HOME OPENCODE_CONFIG_DIR\nexec ./install.sh\n",
			{ mode: 0o755 },
		);
		const git = (...args: string[]) => exec("git", ["-C", f.source, ...args]);
		await git("init", "--initial-branch=main");
		await git("add", ".");
		await git("commit", "--no-gpg-sign", "-m", "Starter integration fixture");
		const socket = createServer();
		await new Promise<void>((resolve, reject) => {
			socket.once("error", reject);
			socket.listen(0, "127.0.0.1", resolve);
		});
		const port = (socket.address() as { port: number }).port;
		await new Promise<void>((resolve, reject) => socket.close((e) => (e ? reject(e) : resolve())));
		let daemon: ChildProcess | undefined;
		try {
			const server = spawn(
				"git",
				[
					"daemon",
					"--reuseaddr",
					"--export-all",
					"--verbose",
					"--listen=127.0.0.1",
					`--port=${port}`,
					`--base-path=${f.dir}`,
					f.dir,
				],
				{ stdio: ["ignore", "ignore", "pipe"] },
			);
			daemon = server;
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.once("exit", (code) => reject(new Error(`Git daemon exited ${code}`)));
				server.stderr.on("data", (data) => {
					if (String(data).includes("Ready to rumble")) resolve();
				});
			});
			const manager = new Dotfiles(join(f.dir, "engine-state"), f.destination);
			const config = { repository: `git://127.0.0.1:${port}/repo`, script: "test-install.sh" };
			const plan = await manager.prepare(config);
			expect(plan.script).toBe("test-install.sh");
			expect(existsSync(join(f.destination, skill))).toBe(false);
			for (let attempt = 0; attempt < 2; attempt++) {
				const next = attempt === 0 ? plan : await manager.prepare(config);
				await manager.apply(next.id);
				const deadline = Date.now() + 15_000;
				while (manager.active() && Date.now() < deadline) await Bun.sleep(25);
				expect(manager.active()).toBe(false);
				const result = manager.status().run;
				if (result?.state !== "succeeded") throw new Error(result?.log ?? "No install result");
				expect(result.exitCode).toBe(0);
				if (attempt === 1) expect(result.log).not.toContain("diff --git");
			}
			expect(await readFile(join(f.destination, skill), "utf8")).toContain("name: review-changes");
		} finally {
			daemon?.kill();
		}
	}, 40_000);
});
