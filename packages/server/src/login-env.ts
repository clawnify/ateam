// Resolving the user's real login environment.
//
// A macOS app launched from Finder (or relaunched by the updater) inherits
// launchd's PATH — `/usr/bin:/bin:/usr/sbin:/sbin` — not the user's. Nearly
// everything this engine shells out to lives outside it: the agent CLIs
// (`claude`, `codex`, `opencode`), `gh` for every GitHub operation, and the
// headless turns behind task tagging and AI search. So the engine resolves the
// login shell's PATH once at startup and adopts it into `process.env`, which
// every child then inherits.
//
// The hard part is not the probe, it is what happens when the probe MISSES.
// One silent miss used to break agent launch, agent detection, tagging, AI
// search and every `gh` call for the whole life of the app, with no recovery
// but a restart (VS Code carries the same single-shot design, which is why its
// failure dialog offers a "Restart" button). Three layers make a miss
// survivable here: a background retry, the last PATH that resolved on this
// machine, and finally the dirs agent CLIs are actually installed into.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type AteamDb, repo } from "@ateam/db";

const pexec = promisify(execFile);

/** VS Code's default, and its FAQ's answer to "why did resolution time out". */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * Backoff for re-probing after a miss. A miss is nearly always contention at
 * login (a cold disk, an rc file loading nvm/rvm while the rest of the machine
 * also starts), so the retries walk out to ~6 minutes and stop: past that the
 * shell genuinely cannot answer, and the fallbacks stand.
 */
export const RETRY_DELAYS_MS = [5_000, 20_000, 60_000, 300_000];

/**
 * Defuses the two documented ways an interactive shell hangs a probe forever:
 * oh-my-zsh's update prompt (shell-env#19) and its tmux plugin exec'ing tmux
 * (shell-env#4). ATEAM_RESOLVING_ENVIRONMENT mirrors VS Code's
 * VSCODE_RESOLVING_ENVIRONMENT, so a slow rc file can skip its own init.
 */
const PROBE_ENV = {
	ATEAM_RESOLVING_ENVIRONMENT: "1",
	DISABLE_AUTO_UPDATE: "true",
	ZSH_TMUX_AUTOSTART: "false",
	ZSH_TMUX_AUTOSTARTED: "true",
};

const MARKER = /__ATEAM_PATH__([\s\S]*?)__SEP__([\s\S]*?)__END__/;
const PROBE_CMD = 'printf "__ATEAM_PATH__%s__SEP__%s__END__" "$PATH" "${LANG:-}"';

export interface LoginEnv {
	path: string;
	lang: string;
}

/**
 * Where agent CLIs and `gh` land when nothing else can be resolved. Deliberately
 * not `fix-path`'s list, which predates Apple Silicon and names neither
 * `/opt/homebrew/bin` nor `~/.local/bin` — the two that matter most here, the
 * second being what `claude`'s own installer targets. Version-managed dirs (nvm,
 * rbenv) cannot be named statically; the remembered PATH covers those.
 */
export function fallbackBinDirs(home: string = homedir()): string[] {
	return [
		join(home, ".local", "bin"),
		join(home, ".bun", "bin"),
		join(home, ".cargo", "bin"),
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
		"/usr/local/bin",
	];
}

/**
 * This PATH is adopted into every child process the app spawns, so it is a
 * trust boundary: reject anything that doesn't look like one. Control
 * characters genuinely arrive here — a TERM-driven reset sequence leaking into
 * captured output is a known failure of this technique (fix-path#6) — and a
 * PATH naming no directory that exists is a parse that went wrong rather than
 * an answer from the shell.
 */
export function sanitizeLoginPath(raw: string): string | null {
	const clean = raw
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
		.replace(/\u001B\[[0-9;?]*[\u0020-\u002F]*[@-~]/g, "")
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
		.replace(/[\u0000-\u001F\u007F]/g, "");
	const dirs = clean.split(":").filter(Boolean);
	if (!dirs.some((d) => d.startsWith("/") && existsSync(d))) return null;
	return dirs.join(":");
}

/** Append the dirs a PATH doesn't already have, preserving its own order. */
export function appendMissingDirs(path: string, dirs: string[]): string {
	const own = path.split(":").filter(Boolean);
	const have = new Set(own);
	return [...own, ...dirs.filter((d) => !have.has(d))].join(":");
}

/** One probe of the login shell. Null on any failure — timeout, junk, non-zero exit. */
export async function probeLoginEnv(
	shell = process.env.SHELL || "/bin/zsh",
	env: NodeJS.ProcessEnv = process.env,
): Promise<LoginEnv | null> {
	try {
		// Interactive AND login: PATH is very often exported from ~/.zshrc, which a
		// non-interactive shell never reads, rather than from ~/.zprofile. Same
		// flags VS Code and shell-env use.
		const { stdout } = await pexec(shell, ["-ilc", PROBE_CMD], {
			encoding: "utf8",
			timeout: PROBE_TIMEOUT_MS,
			env: { ...env, ...PROBE_ENV },
		});
		const m = stdout.match(MARKER);
		if (!m?.[1]) return null;
		const path = sanitizeLoginPath(m[1]);
		return path ? { path, lang: m[2] ?? "" } : null;
	} catch {
		return null;
	}
}

/**
 * Take a resolved login environment as this process's own. `at` is when the
 * resolution happened, on the caller's clock — one clock per mechanism, so an
 * injected one in a test isn't quietly overruled by the wall clock in here.
 */
function adoptLoginEnv(db: AteamDb, env: NodeJS.ProcessEnv, resolved: LoginEnv, at: number): void {
	env.PATH = resolved.path;
	// GUI apps also launch with no LANG, and pbcopy then reads UTF-8 as Mac OS
	// Roman — copying "→ — €" out of a terminal yields mojibake.
	if (!env.LANG) env.LANG = resolved.lang || "en_US.UTF-8";
	repo.updateSettings(db, { loginPath: resolved.path });
	// Startup counts as a resolution, so the first refresh after launch is a
	// no-op rather than a second probe of a machine nothing has changed yet.
	lastRefreshAt = at;
}

/**
 * How often a refresh is allowed to pay for a real probe. An interactive login
 * shell can take up to PROBE_TIMEOUT_MS to answer, so the callers below (the
 * agent catalog, and a launch about to be refused) must not each spend that.
 */
export const REFRESH_MIN_INTERVAL_MS = 60_000;
let lastRefreshAt = 0;

/** Test seam: forget that a refresh just happened. */
export function resetLoginPathRefresh(): void {
	lastRefreshAt = 0;
}

/**
 * Re-resolve the login shell's PATH and adopt it, if one hasn't been resolved
 * recently.
 *
 * `ensureLoginEnv` runs ONCE at startup and returns the moment a probe lands,
 * so without this the PATH this process spawns everything with is a snapshot of
 * the machine as it was when the app opened. A CLI installed afterwards — by
 * this app's own installer, by brew, by a terminal — stays invisible until the
 * app is restarted, and "restart Ateam" becomes the unwritten last step of
 * every install. Observed with `opencode`: the installer appended to ~/.zshrc,
 * a fresh login shell found it, and the running app could not.
 *
 * Returns whether the PATH changed, so a caller can say something happened.
 */
export async function refreshLoginPath(opts: {
	db: AteamDb;
	env?: NodeJS.ProcessEnv;
	probe?: () => Promise<LoginEnv | null>;
	platform?: NodeJS.Platform;
	now?: () => number;
	/** Probe even if one ran recently — for the moment right after an install. */
	force?: boolean;
}): Promise<boolean> {
	const {
		db,
		env = process.env,
		probe = () => probeLoginEnv(),
		platform = process.platform,
		now = Date.now,
		force = false,
	} = opts;
	// Same reason ensureLoginEnv skips it: only a GUI launch loses the
	// environment. A Linux daemon was started FROM the login shell, and its
	// PTYs re-read the profile on every spawn.
	if (platform !== "darwin") return false;
	const at = now();
	if (!force && at - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) return false;
	lastRefreshAt = at;
	const resolved = await probe();
	if (!resolved) return false;
	const before = env.PATH;
	adoptLoginEnv(db, env, resolved, at);
	return env.PATH !== before;
}

export interface EnsureLoginEnvOptions {
	db: AteamDb;
	log: (line: string) => void;
	/** The env to mutate. Injectable for tests; the engine mutates process.env. */
	env?: NodeJS.ProcessEnv;
	probe?: () => Promise<LoginEnv | null>;
	platform?: NodeJS.Platform;
	home?: string;
	retryDelaysMs?: number[];
}

/**
 * Adopt the login shell's PATH (and LANG) into `env`, then keep trying in the
 * background until one probe succeeds. Awaiting the first attempt is
 * deliberate: agent detection and `gh` run within a second of the engine coming
 * up, and a wrong answer there is what the user sees.
 */
export async function ensureLoginEnv(opts: EnsureLoginEnvOptions): Promise<void> {
	const {
		db,
		log,
		env = process.env,
		probe = () => probeLoginEnv(),
		platform = process.platform,
		home = homedir(),
		retryDelaysMs = RETRY_DELAYS_MS,
	} = opts;
	// Only a GUI launch loses the environment; a Linux box runs the daemon from
	// the login shell that started it.
	if (platform !== "darwin") return;

	const adopt = (resolved: LoginEnv): void => adoptLoginEnv(db, env, resolved, Date.now());

	const resolved = await probe();
	if (resolved) {
		adopt(resolved);
		return;
	}

	// Fall back, best first: the last PATH that worked on this machine, then the
	// dirs agent CLIs install into. Both only ever ADD to what launchd gave us,
	// and both are replaced the moment a retry succeeds.
	const remembered = repo.getSettings(db).loginPath;
	if (remembered) {
		log("[ateam] login-shell probe failed; using the PATH last resolved on this machine");
		env.PATH = remembered;
	} else {
		log("[ateam] login-shell probe failed and none is remembered; using known agent CLI dirs");
		env.PATH = appendMissingDirs(env.PATH ?? "", fallbackBinDirs(home));
	}
	if (!env.LANG) env.LANG = "en_US.UTF-8";

	// Re-probe on a backoff until one lands; each success replaces the fallback.
	let attempt = 0;
	const retry = (): void => {
		const delay = retryDelaysMs[attempt];
		if (delay === undefined) {
			log("[ateam] login-shell PATH never resolved; agent CLIs outside the known dirs won't run");
			return;
		}
		attempt++;
		// Unref'd: a pending retry must never be the reason the process stays up.
		setTimeout(() => {
			void probe().then((late) => {
				if (!late) return retry();
				log(`[ateam] login-shell PATH resolved on retry ${attempt}`);
				adopt(late);
			});
		}, delay).unref();
	};
	retry();
}
