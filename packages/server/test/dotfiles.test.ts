import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { createRpcClient, dotfilesClient } from "@ateam/protocol";
import { createDispatcher } from "../src/dispatcher";
import { Dotfiles, dotfilesFor, validateDotfiles } from "../src/dotfiles";
import type { Engine } from "../src/engine";
import { serveRpc } from "../src/rpc";
import { streamClientTransport, streamServerTransport } from "../src/transport/stream";

const exec = promisify(execFile);
const git = async (dir: string, ...args: string[]) =>
	(await exec("git", ["-c", "core.hooksPath=/dev/null", "-C", dir, ...args])).stdout.trim();
let root: string;
let port: number;
let daemon: ChildProcess;
let serial = 0;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "ateam-dotfiles-test-"));
	const socket = createServer();
	await new Promise<void>((resolve, reject) => {
		socket.once("error", reject);
		socket.listen(0, "127.0.0.1", resolve);
	});
	port = (socket.address() as { port: number }).port;
	await new Promise<void>((resolve, reject) => socket.close((e) => (e ? reject(e) : resolve())));
	daemon = spawn(
		"git",
		[
			"daemon",
			"--reuseaddr",
			"--export-all",
			"--verbose",
			"--listen=127.0.0.1",
			`--port=${port}`,
			`--base-path=${root}`,
			root,
		],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	await new Promise<void>((resolve, reject) => {
		daemon.on("error", reject);
		daemon.once("exit", (code) => reject(new Error(`git daemon exited: ${code}`)));
		daemon.stderr?.on("data", (chunk) => {
			if (String(chunk).includes("Ready to rumble")) resolve();
		});
	});
});
afterAll(async () => {
	daemon?.kill();
	if (root) await rm(root, { recursive: true, force: true });
});

async function fixture(files: Record<string, string | { content: string; mode: number }>) {
	const name = `repo-${++serial}`;
	const source = join(root, name);
	const home = join(root, `home-${serial}`);
	const state = join(root, `state-${serial}`);
	await mkdir(source);
	await mkdir(home);
	await git(source, "init", "--initial-branch=main");
	for (const [path, file] of Object.entries(files)) {
		await writeFile(join(source, path), typeof file === "string" ? file : file.content);
		await chmod(join(source, path), typeof file === "string" ? 0o755 : file.mode);
	}
	await git(source, "add", ".");
	await git(source, "commit", "--no-gpg-sign", "-m", "Dotfiles fixture");
	const config = { repository: `git://127.0.0.1:${port}/${name}`, script: "" };
	return { source, home, state, config, manager: new Dotfiles(state, home) };
}

async function finished(manager: Dotfiles) {
	const deadline = Date.now() + 5000;
	while (manager.active() && Date.now() < deadline) await Bun.sleep(20);
	expect(manager.active()).toBe(false);
	const run = manager.status().run;
	if (!run) throw new Error("Expected an install run");
	return run;
}

describe("dotfiles: real clone, preview and execution", () => {
	it("the box-scoped client reaches the dispatcher over RPC and the run survives disconnect", async () => {
		const f = await fixture({ "install.sh": "#!/bin/sh\nsleep 0.1\necho rpc-finished\n" });
		const data = join(root, `rpc-${serial}`);
		const engine = {
			services: { userDataDir: data, loopRunner: {}, pty: { release: () => {} } },
			on: () => () => {},
			ptyReady: async () => {},
		} as unknown as Engine;
		const c2s = new PassThrough();
		const s2c = new PassThrough();
		serveRpc(engine, createDispatcher(engine), streamServerTransport(c2s, s2c));
		const client = dotfilesClient(createRpcClient(streamClientTransport(s2c, c2s)));
		expect((await client.status()).prepared).toBeNull();
		const plan = await client.prepare(f.config);
		expect(plan.directory.startsWith(data)).toBe(true);
		expect((await client.apply(plan.id)).run?.state).toBe("running");
		c2s.end();
		s2c.end();
		expect((await finished(dotfilesFor(data))).log).toContain("rpc-finished");
	});
	it("preview never runs; apply uses isolated HOME, survives UI absence, and persists its result", async () => {
		const f = await fixture({
			"install.sh":
				'#!/bin/sh\nsleep 0.1\nprintf installed > "$HOME/marker"\necho installed\necho stderr-output >&2\n',
		});
		const plan = await f.manager.prepare(f.config);
		expect(plan.script).toBe("install.sh");
		expect(existsSync(join(f.home, "marker"))).toBe(false);
		expect(new Dotfiles(f.state, f.home).status().prepared?.id).toBe(plan.id);
		expect((await f.manager.apply(plan.id)).run?.state).toBe("running");
		await expect(f.manager.apply(plan.id)).rejects.toThrow("already");
		await expect(f.manager.prepare(f.config)).rejects.toThrow("already");
		const result = await finished(f.manager);
		expect(result.state).toBe("succeeded");
		expect(result.log).toContain("stderr-output");
		expect(await readFile(join(f.home, "marker"), "utf8")).toBe("installed");
		expect(new Dotfiles(f.state, f.home).status().run).toEqual(result);
		await expect(f.manager.apply(plan.id)).rejects.toThrow("Preview");
	});

	it("an edited or advanced checkout invalidates approval; the next preview fetches upstream", async () => {
		const f = await fixture({ "install.sh": "#!/bin/sh\necho first\n" });
		const plan = await f.manager.prepare(f.config);
		await writeFile(join(plan.directory, "untracked"), "keep me");
		await expect(f.manager.apply(plan.id)).rejects.toThrow("local changes");
		expect(f.manager.status().prepared).toBeNull();
		await expect(f.manager.prepare(f.config)).rejects.toThrow("local changes");
		expect(await readFile(join(plan.directory, "untracked"), "utf8")).toBe("keep me");
		await rm(join(plan.directory, "untracked"));
		const next = await f.manager.prepare(f.config);
		await writeFile(join(f.source, "install.sh"), "#!/bin/sh\necho second\n");
		await git(f.source, "commit", "--no-gpg-sign", "-am", "Second revision");
		await git(next.directory, "pull", "--ff-only");
		await expect(f.manager.apply(next.id)).rejects.toThrow("changed since preview");
		expect(f.manager.status().prepared).toBeNull();
		const updated = await f.manager.prepare(f.config);
		expect(updated.commit).not.toBe(plan.commit);
		await f.manager.apply(updated.id);
		expect((await finished(f.manager)).log).toContain("second");
	});

	it("allows a custom executable, reports missing scripts, and rejects escaped and non-executable scripts", async () => {
		const f = await fixture({
			"custom.sh": "#!/bin/sh\necho custom\n",
			"install.sh": { content: "not executable", mode: 0o644 },
		});
		const missing = await f.manager.prepare(f.config);
		expect(missing.script).toBeNull();
		await expect(f.manager.apply(missing.id)).rejects.toThrow("Preview");
		await expect(f.manager.prepare({ ...f.config, script: "install.sh" })).rejects.toThrow(
			"executable",
		);
		const custom = await f.manager.prepare({ ...f.config, script: "./custom.sh" });
		expect(custom.script).toBe("custom.sh");
		await f.manager.apply(custom.id);
		expect((await finished(f.manager)).log).toContain("custom");
		await symlink("custom.sh", join(f.source, "escape.sh"));
		await git(f.source, "add", ".");
		await git(f.source, "commit", "--no-gpg-sign", "-m", "Symlink");
		await expect(f.manager.prepare({ ...f.config, script: "escape.sh" })).rejects.toThrow(
			"regular file",
		);
	});

	it("keeps failure output and partial changes, and never reruns a consumed preview", async () => {
		const f = await fixture({
			"install.sh": '#!/bin/sh\necho partial > "$HOME/partial"\necho failed-install >&2\nexit 7\n',
		});
		const plan = await f.manager.prepare(f.config);
		await f.manager.apply(plan.id);
		const run = await finished(f.manager);
		expect(run.state).toBe("failed");
		expect(run.exitCode).toBe(7);
		expect(run.message).toContain("Changes already made remain");
		expect(run.log).toContain("failed-install");
		expect(existsSync(join(f.home, "partial"))).toBe(true);
		await expect(f.manager.apply(plan.id)).rejects.toThrow("Preview");
	});

	it("fails closed after an engine loses a run result", async () => {
		const f = await fixture({ "install.sh": "#!/bin/sh\nexit 0\n" });
		const plan = await f.manager.prepare(f.config);
		await writeFile(
			join(f.state, "state.json"),
			JSON.stringify({
				prepared: null,
				run: {
					plan,
					state: "running",
					pid: null,
					startedAt: 1,
					finishedAt: null,
					exitCode: null,
					message: null,
				},
			}),
		);
		const restored = new Dotfiles(f.state, f.home);
		expect(restored.status().run?.state).toBe("interrupted");
		await expect(restored.apply(plan.id)).rejects.toThrow("Preview");
	});
});

it("rejects credentials, local paths, injected arguments and escaped script paths", () => {
	for (const repository of [
		"/tmp/repo",
		"file:///tmp/repo",
		"--upload-pack=evil",
		"https://user:token@github.com/u/r",
		"https://github.com/u/r?token=secret",
		"git@github.com:u/r\ncommand",
	]) {
		expect(() => validateDotfiles({ repository, script: "" })).toThrow();
	}
	for (const script of ["../install", "/tmp/install", "a/../../install", "bad\u0000path", "a\\b"]) {
		expect(() => validateDotfiles({ repository: "https://github.com/u/r", script })).toThrow();
	}
	expect(
		validateDotfiles({ repository: " git@github.com:u/r.git ", script: "./bootstrap" }),
	).toEqual({ repository: "git@github.com:u/r.git", script: "bootstrap" });
});
