import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { access, lstat, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { cloneRepo } from "@ateam/git-core";
import type { DotfilesConfig, DotfilesPlan, DotfilesRun, DotfilesStatus } from "@ateam/protocol";
import { readSettings } from "./settings-file";

const exec = promisify(execFile);
const SCRIPTS = [
	"install.sh",
	"install",
	"bootstrap.sh",
	"bootstrap",
	"script/bootstrap",
	"setup.sh",
	"setup",
	"script/setup",
];
// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters at the RPC boundary.
const CONTROL = /[\x00-\x1f\x7f]/;
const LOG_LIMIT = 64 * 1024;

/** Also validates hand-edited settings at the execution boundary. */
export function validateDotfiles(input: unknown): DotfilesConfig {
	const value = input as Partial<DotfilesConfig> | null;
	if (!value || typeof value.repository !== "string" || typeof value.script !== "string") {
		throw new Error("Enter a repository URL and an optional script path.");
	}
	const repository = value.repository.trim();
	const script = value.script.trim().replace(/^\.\//, "");
	if (repository.length > 2048 || CONTROL.test(repository) || /\s/.test(repository))
		throw new Error("Invalid repository URL.");
	if (!/^git@[a-zA-Z0-9.-]+:[\w./-]+$/.test(repository)) {
		let url: URL;
		try {
			url = new URL(repository);
		} catch {
			throw new Error("Use an HTTPS or SSH Git repository URL.");
		}
		if (
			!["https:", "ssh:", "git:"].includes(url.protocol) ||
			!url.hostname ||
			url.password ||
			url.search ||
			url.hash ||
			(url.username && !(url.protocol === "ssh:" && url.username === "git"))
		) {
			throw new Error(
				"Use a Git repository URL without embedded credentials. Connect GitHub on this box for private repos.",
			);
		}
	}
	if (
		script.length > 512 ||
		isAbsolute(script) ||
		script.split("/").includes("..") ||
		CONTROL.test(script) ||
		script.includes("\\")
	) {
		throw new Error("The script must be a relative path inside the repository.");
	}
	return { repository, script };
}

interface Saved {
	prepared: DotfilesPlan | null;
	run: (Omit<DotfilesRun, "log"> & { pid: number | null }) | null;
}

/** One manager per engine data directory, shared by its connections. */
export class Dotfiles {
	private busy = false;
	private running = false;
	private saved: Saved | undefined;
	private readonly statePath: string;
	private readonly logPath: string;
	constructor(
		private readonly root: string,
		private readonly home = homedir(),
	) {
		this.statePath = join(root, "state.json");
		this.logPath = join(root, "apply.log");
	}

	private read(): Saved {
		if (this.saved) return this.saved;
		try {
			this.saved = JSON.parse(readFileSync(this.statePath, "utf8"));
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT")
				throw new Error(
					"Dotfiles state could not be read. Keep the state file and inspect it before retrying.",
				);
			this.saved = { prepared: null, run: null };
		}
		if (!this.saved)
			throw new Error("Invalid dotfiles state. Inspect its state file before retrying.");
		return this.saved;
	}

	private save(): void {
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		const tmp = `${this.statePath}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.read()), { mode: 0o600 });
		renameSync(tmp, this.statePath);
	}

	active(): boolean {
		if (this.busy || this.running) return true;
		const run = this.read().run;
		if (run?.state !== "running") return false;
		if (run.pid) {
			try {
				process.kill(run.pid, 0);
				return true;
			} catch {
				/* process has ended */
			}
		}
		run.state = "interrupted";
		run.finishedAt = Date.now();
		run.message =
			"The engine lost the install result. Inspect the log and the box before preparing another attempt.";
		this.save();
		return false;
	}

	status(): DotfilesStatus {
		this.active();
		const { prepared, run } = this.read();
		let log = "";
		try {
			log = readFileSync(this.logPath, "utf8");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}
		const { pid: _, ...publicRun } = run ?? { pid: null };
		return {
			defaultConfig: readSettings().settings.engine.dotfiles ?? null,
			prepared,
			run: run ? ({ ...publicRun, log } as DotfilesRun) : null,
		};
	}

	private directory(config: DotfilesConfig): string {
		return join(
			this.root,
			createHash("sha256").update(config.repository).digest("hex").slice(0, 24),
		);
	}

	private async git(dir: string, ...args: string[]): Promise<string> {
		const r = await exec("git", ["-c", "core.hooksPath=/dev/null", "-C", dir, ...args], {
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			timeout: 120_000,
			maxBuffer: 1024 * 1024,
		});
		return r.stdout.trim();
	}

	private async clean(dir: string): Promise<void> {
		if (await this.git(dir, "status", "--porcelain", "--untracked-files=all")) {
			throw new Error(
				"The dotfiles checkout has local changes. Keep or commit them in its terminal before previewing again.",
			);
		}
	}

	private async script(dir: string, path: string): Promise<void> {
		const full = join(dir, path);
		const inside = relative(await realpath(dir), await realpath(full));
		if (inside.startsWith("../") || isAbsolute(inside) || (await lstat(full)).isSymbolicLink()) {
			throw new Error("The install script must be a regular file inside this checkout.");
		}
		const entry = await this.git(dir, "ls-files", "--stage", "--", `:(literal)${path}`);
		if (!entry.startsWith("100755 ") || !(await lstat(full)).isFile()) {
			throw new Error(
				"The install script must be tracked and executable. Commit its executable permission, then preview again.",
			);
		}
		await access(full, constants.X_OK);
	}

	async prepare(input: unknown): Promise<DotfilesPlan> {
		const config = validateDotfiles(input);
		if (this.active())
			throw new Error("Dotfiles are already being prepared or applied on this box.");
		this.busy = true;
		const dir = this.directory(config);
		try {
			this.read().prepared = null;
			this.save();
			if (!existsSync(dir)) {
				try {
					await cloneRepo(config.repository, dir, {
						timeout: 120_000,
						env: {
							...process.env,
							GIT_TERMINAL_PROMPT: "0",
							GIT_CONFIG_COUNT: "1",
							GIT_CONFIG_KEY_0: "core.hooksPath",
							GIT_CONFIG_VALUE_0: "/dev/null",
						},
					});
				} catch (e) {
					await rm(dir, { recursive: true, force: true });
					throw e;
				}
			} else {
				if ((await lstat(dir)).isSymbolicLink())
					throw new Error("The managed checkout cannot be a symlink.");
				await this.clean(dir);
				// Pin the fetch to the requested URL, even if origin was changed locally.
				await this.git(dir, "fetch", "--no-tags", "--", config.repository, "HEAD");
				await this.git(dir, "merge", "--ff-only", "FETCH_HEAD");
			}
			await this.clean(dir);
			let script: string | null = config.script || null;
			if (!script) {
				for (const candidate of SCRIPTS) {
					if (!existsSync(join(dir, candidate))) continue;
					const info = await lstat(join(dir, candidate));
					if (info.isFile() && info.mode & 0o111) {
						script = candidate;
						break;
					}
				}
			}
			if (script) await this.script(dir, script);
			const plan = {
				id: randomUUID(),
				config,
				directory: dir,
				script,
				commit: await this.git(dir, "rev-parse", "HEAD"),
			};
			this.read().prepared = plan;
			this.save();
			return plan;
		} finally {
			this.busy = false;
		}
	}

	async apply(id: unknown): Promise<DotfilesStatus> {
		if (this.active())
			throw new Error("Dotfiles are already being prepared or applied on this box.");
		const plan = this.read().prepared;
		if (typeof id !== "string" || !plan || plan.id !== id || !plan.script)
			throw new Error("Preview a repository with an install script before applying it.");
		this.busy = true;
		try {
			const dir = this.directory(validateDotfiles(plan.config));
			if (resolve(dir) !== resolve(plan.directory))
				throw new Error("Preview this repository again.");
			if ((await lstat(dir)).isSymbolicLink())
				throw new Error("The managed checkout cannot be a symlink.");
			await this.clean(dir);
			if ((await this.git(dir, "rev-parse", "HEAD")) !== plan.commit)
				throw new Error("The checkout changed since preview. Preview again before applying.");
			await this.script(dir, plan.script);
			const run: NonNullable<Saved["run"]> = {
				plan,
				state: "running",
				startedAt: Date.now(),
				finishedAt: null,
				exitCode: null,
				message: null,
				pid: null,
			};
			this.read().prepared = null; // one preview authorizes one attempt, including failures
			this.read().run = run;
			writeFileSync(this.logPath, "", { mode: 0o600 });
			this.save();
			const child = spawn(join(dir, plan.script), [], {
				cwd: dir,
				env: { ...process.env, HOME: this.home, GIT_TERMINAL_PROMPT: "0" },
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			});
			run.pid = child.pid ?? null;
			this.running = true;
			let log = "";
			let outputError: string | null = null;
			const append = (chunk: Buffer) => {
				log = (log + chunk.toString()).slice(-LOG_LIMIT);
				try {
					writeFileSync(this.logPath, log, { mode: 0o600 });
				} catch (e) {
					outputError = `Could not save install output: ${(e as Error).message}`;
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							/* exited */
						}
					}
				}
			};
			child.stdout.on("data", append);
			child.stderr.on("data", append);
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				if (child.pid) {
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch {
						/* exited */
					}
				}
			}, 30 * 60_000);
			timer.unref();
			let spawnError: string | null = null;
			child.on("error", (e) => {
				spawnError = e.message;
			});
			child.on("close", (code, signal) => {
				this.running = false;
				clearTimeout(timer);
				run.state = code === 0 && !spawnError && !timedOut && !outputError ? "succeeded" : "failed";
				run.exitCode = code;
				run.finishedAt = Date.now();
				run.message = timedOut
					? "Stopped after 30 minutes. The script must run without interactive input."
					: (outputError ??
						spawnError ??
						(code === 0
							? null
							: `Install stopped (${signal ?? `exit ${code}`}). Changes already made remain on the box.`));
				run.pid = null;
				try {
					this.save();
				} catch (e) {
					run.message = `Could not save the install result: ${(e as Error).message}. Inspect the box before retrying.`;
					console.error("[dotfiles]", run.message);
				}
			});
			this.save();
			return this.status();
		} catch (e) {
			// An invalidated checkout needs fresh approval, even if it is repaired later.
			if (this.read().prepared?.id === plan.id) {
				this.read().prepared = null;
				this.save();
			}
			throw e;
		} finally {
			this.busy = false;
		}
	}
}

const managers = new Map<string, Dotfiles>();
export function dotfilesFor(dataDir: string): Dotfiles {
	const root = join(dataDir, "dotfiles");
	let manager = managers.get(root);
	if (!manager) {
		manager = new Dotfiles(root);
		managers.set(root, manager);
	}
	return manager;
}
