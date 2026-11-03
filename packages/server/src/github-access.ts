// GitHub access on this engine's machine (githubAccess:*, v25): which credential gh
// and git use here, what each one reaches, and handing gh a new token without a
// terminal.
//
// It lives in the engine because a box's GitHub sign-in belongs to the box, shared
// by every client that drives it, and because the phone has no SSH: this RPC is the
// only way it can set a box up.
//
// Agents run as the same user as this engine, so anything gh or git can use, an
// agent can read (docs/providers/README.md, "GitHub credentials"). The lever is the
// credential's reach, so status reports each token's kind and `check` says per repo
// whether it can push. The token itself goes to GitHub and into gh's stdin, never
// into argv, a terminal or the reply: status carries its last four characters.
//
// One host only: github.com. GitHub Enterprise boxes keep signing in by hand.
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import {
	cleanGithubToken,
	type GithubAccessDTO,
	type GithubCredentialDTO,
	githubCredentialKind,
	type RepoAccess,
	type RepoAccessDTO,
} from "@ateam/protocol";

/** Run a program, feeding it `input` on stdin. Rejects on a non-zero exit, with its stderr. */
export type Run = (
	cmd: string,
	args: string[],
	opts?: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>;

/** What this module reaches outside itself, so tests can stand in for gh, git and GitHub. */
export interface GithubAccessDeps {
	run: Run;
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
	env: NodeJS.ProcessEnv;
	/** The machine's name, for naming its token. Unset in tests: then not reported. */
	hostname?: () => string;
}

const GITHUB_API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 10_000;
/** Repos probed at once: enough to answer a box's projects in about one round trip. */
const PROBE_CONCURRENCY = 6;
/** Repos one check probes at most. */
const MAX_PROBED_REPOS = 200;

export const runProgram: Run = (cmd, args, opts = {}) =>
	new Promise((resolve, reject) => {
		let settled = false;
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		const child = spawn(cmd, args, {
			env: opts.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 20_000);
		child.stdout.on("data", (b: Buffer) => {
			stdout += b.toString("utf8");
		});
		child.stderr.on("data", (b: Buffer) => {
			stderr += b.toString("utf8");
		});
		child.on("error", (err) => settle(() => reject(err)));
		child.on("close", (code, signal) =>
			settle(() => {
				if (code === 0) resolve({ stdout, stderr });
				else reject(new Error(stderr.trim() || `${cmd} exited with ${code ?? signal}`));
			}),
		);
		// A program that exits before reading its stdin would otherwise crash us with EPIPE.
		child.stdin.on("error", () => {});
		child.stdin.end(opts.input ?? "");
	});

export const defaultDeps: GithubAccessDeps = {
	run: runProgram,
	fetch: (input, init) => fetch(input, init),
	env: process.env,
	hostname,
};

function isMissingProgram(err: unknown): boolean {
	return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** The environment for asking git, with every way it could stop to prompt turned off. */
function quietGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const quiet: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
	delete quiet.GIT_ASKPASS;
	delete quiet.SSH_ASKPASS;
	return quiet;
}

/** The token gh uses for github.com (GH_TOKEN, GITHUB_TOKEN or its store), "missing" without gh. */
async function readGhToken(
	deps: GithubAccessDeps,
): Promise<{ token: string; source: "store" | "env" } | null | "missing"> {
	try {
		const { stdout } = await deps.run("gh", ["auth", "token", "--hostname", "github.com"], {
			env: deps.env,
		});
		const token = stdout.trim();
		if (!token) return null;
		const fromEnv = (deps.env.GH_TOKEN || deps.env.GITHUB_TOKEN)?.trim();
		return { token, source: fromEnv === token ? "env" : "store" };
	} catch (err) {
		return isMissingProgram(err) ? "missing" : null; // installed but not signed in
	}
}

/**
 * The token git itself sends to github.com, from whichever credential helper is set
 * up (gh's after `gh auth setup-git`, a provider's like boxd's, a store), or null.
 * This is what clone and push use, so it is the ground truth for push access.
 */
async function readGitToken(deps: GithubAccessDeps): Promise<string | null> {
	try {
		const { stdout } = await deps.run(
			"git",
			["-c", "credential.interactive=never", "credential", "fill"],
			{
				input: "protocol=https\nhost=github.com\n\n",
				env: quietGitEnv(deps.env),
				timeoutMs: 15_000,
			},
		);
		return /^password=(.+)$/m.exec(stdout)?.[1]?.trim() || null;
	} catch {
		return null; // no helper answered, and prompting is off
	}
}

interface GithubUser {
	login: string;
	id: number;
	name: string | null;
	expiresAt: number | null;
}

/**
 * GitHub's `GitHub-Authentication-Token-Expiration` header ("2026-12-01 10:00:00 UTC"
 * or with a "-0700" offset), as ms. Only some tokens carry it, so absent is normal.
 */
export function parseTokenExpiry(header: string | null): number | null {
	const m = header
		?.trim()
		.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/);
	if (!m) return null;
	const zone =
		!m[3] || m[3] === "UTC" || m[3] === "Z" ? "Z" : m[3].replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2");
	const ms = Date.parse(`${m[1]}T${m[2]}${zone}`);
	return Number.isNaN(ms) ? null : ms;
}

/**
 * Ask GitHub whose a token is. "rejected" when GitHub says the token is no good
 * (401); "undisclosed" when it answers without saying whose (a 403 or 404 here, a
 * rate limit or a token type that may not read the profile), so the caller lets gh
 * judge the token rather than refusing one that works.
 */
async function askGithub(
	token: string,
	deps: GithubAccessDeps,
): Promise<GithubUser | "rejected" | "undisclosed"> {
	const res = await deps.fetch(`${GITHUB_API}/user`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "ateam",
		},
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (res.status === 401) return "rejected";
	if (res.status === 403 || res.status === 404) {
		await res.body?.cancel().catch(() => {});
		return "undisclosed";
	}
	if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
	const body = (await res.json()) as { login?: unknown; id?: unknown; name?: unknown };
	if (typeof body.login !== "string" || typeof body.id !== "number") {
		throw new Error("GitHub's answer had no login");
	}
	return {
		login: body.login,
		id: body.id,
		name: typeof body.name === "string" && body.name.trim() ? body.name : null,
		expiresAt: parseTokenExpiry(res.headers.get("github-authentication-token-expiration")),
	};
}

/** A token as the wire may carry it: its kind, last four, and what GitHub says of it. */
async function describe(
	token: string,
	deps: GithubAccessDeps,
): Promise<{ credential: GithubCredentialDTO; unverified: string | null }> {
	const base = { kind: githubCredentialKind(token), hint: token.slice(-4) };
	try {
		const user = await askGithub(token, deps);
		if (user === "rejected") {
			return {
				credential: { ...base, login: null, rejected: true, expiresAt: null },
				unverified: null,
			};
		}
		if (user === "undisclosed") {
			return {
				credential: { ...base, login: null, rejected: false, expiresAt: null },
				unverified: "GitHub took the token but didn't say whose it is.",
			};
		}
		return {
			credential: { ...base, login: user.login, rejected: false, expiresAt: user.expiresAt },
			unverified: null,
		};
	} catch (err) {
		return {
			credential: { ...base, login: null, rejected: false, expiresAt: null },
			unverified: `Couldn't reach GitHub to check: ${errorText(err)}`,
		};
	}
}

/** githubAccess:status. Reads only; never changes what gh or git use. */
export async function githubAccessStatus(
	deps: GithubAccessDeps = defaultDeps,
): Promise<GithubAccessDTO> {
	const [gh, gitToken] = await Promise.all([readGhToken(deps), readGitToken(deps)]);
	const ghCredential = gh === "missing" ? null : gh;
	const git: GithubAccessDTO["git"] = !gitToken
		? "none"
		: ghCredential && gitToken === ghCredential.token
			? "gh"
			: "other";
	const [ghDescribed, gitDescribed] = await Promise.all([
		ghCredential ? describe(ghCredential.token, deps) : null,
		git === "other" && gitToken ? describe(gitToken, deps) : null,
	]);
	return {
		ghInstalled: gh !== "missing",
		gh:
			ghDescribed && ghCredential
				? { ...ghDescribed.credential, source: ghCredential.source }
				: null,
		git,
		gitCredential: gitDescribed?.credential ?? null,
		unverified: ghDescribed?.unverified ?? gitDescribed?.unverified ?? null,
		...(deps.hostname ? { hostname: deps.hostname() } : {}),
	};
}

/**
 * Whether git is signed in to GitHub by a helper set system-wide, which is how a
 * provider wires its own (boxd's, in /etc/gitconfig). `gh auth setup-git` writes a
 * global helper that resets that chain, silently replacing the provider's, so a
 * connect leaves such a helper alone (docs/providers/boxd.md).
 */
async function hasSystemCredentialHelper(deps: GithubAccessDeps): Promise<boolean> {
	try {
		const { stdout } = await deps.run(
			"git",
			["config", "--system", "--get-regexp", "^credential\\..*helper$"],
			{ env: deps.env },
		);
		return stdout.split("\n").some((line) => line.trim().split(/\s+/)[1]);
	} catch {
		return false; // exit 1: none set (or no system config at all)
	}
}

/**
 * Commits need a name and an email, and `gh auth login` sets neither. Fill in only
 * what is missing, from the account: its noreply address keeps the real one private.
 */
async function ensureGitIdentity(user: GithubUser, deps: GithubAccessDeps): Promise<void> {
	const get = async (key: string) => {
		try {
			return (
				await deps.run("git", ["config", "--global", "--get", key], { env: deps.env })
			).stdout.trim();
		} catch {
			return "";
		}
	};
	try {
		if (!(await get("user.name"))) {
			await deps.run("git", ["config", "--global", "user.name", user.name ?? user.login], {
				env: deps.env,
			});
		}
		if (!(await get("user.email"))) {
			await deps.run(
				"git",
				["config", "--global", "user.email", `${user.id}+${user.login}@users.noreply.github.com`],
				{ env: deps.env },
			);
		}
	} catch {
		// Without an identity commits fail loudly later; the token is still connected.
	}
}

/**
 * githubAccess:connect. Check the token with GitHub first, so a bad paste gets a
 * sentence instead of gh's error; hand it to gh on stdin; let git use gh's token
 * unless a provider's helper signs git in; then answer the new status.
 */
export async function connectGithubToken(
	input: unknown,
	deps: GithubAccessDeps = defaultDeps,
): Promise<GithubAccessDTO> {
	const token = typeof input === "string" ? cleanGithubToken(input) : null;
	if (!token) {
		throw new Error(
			"That doesn't look like a GitHub token. Copy the whole token GitHub shows once you generate it: it starts with github_pat_.",
		);
	}
	if ((deps.env.GH_TOKEN || deps.env.GITHUB_TOKEN)?.trim()) {
		throw new Error(
			"GH_TOKEN is set in this box's engine environment, and gh always prefers it to a stored token. Remove it there first.",
		);
	}
	let user: GithubUser | "rejected" | "undisclosed";
	try {
		user = await askGithub(token, deps);
	} catch (err) {
		throw new Error(`Couldn't reach GitHub from this box to check the token: ${errorText(err)}`);
	}
	if (user === "rejected") {
		throw new Error(
			"GitHub refused this token. It may have expired, been revoked, or been copied only in part.",
		);
	}
	const gitBefore = await readGitToken(deps);
	try {
		await deps.run("gh", ["auth", "login", "--hostname", "github.com", "--with-token"], {
			input: `${token}\n`,
			env: deps.env,
		});
	} catch (err) {
		if (isMissingProgram(err)) {
			throw new Error("This box has no GitHub CLI (gh). Update the box to install it.");
		}
		throw new Error(`gh didn't take the token: ${errorText(err)}`);
	}
	const providerSignsGitIn =
		gitBefore !== null && gitBefore !== token && (await hasSystemCredentialHelper(deps));
	if (!providerSignsGitIn) {
		try {
			await deps.run("gh", ["auth", "setup-git", "--hostname", "github.com"], { env: deps.env });
		} catch {
			// Status reports git as unable to sign in, with the way to fix it.
		}
	}
	// Without the account, the identity is left to the next connect or the
	// desktop's readiness probe, which derives it through gh.
	if (user !== "undisclosed") await ensureGitIdentity(user, deps);
	return githubAccessStatus(deps);
}

/** `owner/name`, as GitHub allows it; anything else is not probed. */
export function isRepoName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(value) &&
		!/\/\.{1,2}$/.test(value)
	);
}

/** One smart-HTTP discovery request: the status git itself would get before cloning or pushing. */
async function discover(
	repo: string,
	service: "git-receive-pack" | "git-upload-pack",
	authorization: string | null,
	deps: GithubAccessDeps,
): Promise<number> {
	const res = await deps.fetch(`https://github.com/${repo}.git/info/refs?service=${service}`, {
		headers: { "User-Agent": "ateam", ...(authorization ? { Authorization: authorization } : {}) },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	await res.body?.cancel().catch(() => {});
	return res.status;
}

/**
 * Push, read or nothing, the way `git push` finds out: GitHub answers the
 * receive-pack discovery 200 when the credential may push, 401/403 when it may not
 * (then upload-pack tells read from nothing), and 404 when it can't see the repo.
 * No clone, no side effects.
 */
async function probeRepo(
	repo: string,
	authorization: string | null,
	deps: GithubAccessDeps,
): Promise<RepoAccess> {
	try {
		const push = await discover(repo, "git-receive-pack", authorization, deps);
		if (push === 200) return "push";
		if (push === 404) return "none";
		if (push !== 401 && push !== 403) return "unknown";
		const read = await discover(repo, "git-upload-pack", authorization, deps);
		if (read === 200) return "read";
		return read === 401 || read === 403 || read === 404 ? "none" : "unknown";
	} catch {
		return "unknown";
	}
}

/**
 * githubAccess:check. Probes with the token git uses (it is what clones and
 * pushes), falling back to gh's, then to no token, which still tells a public repo.
 */
export async function checkRepoAccess(
	repos: readonly unknown[],
	deps: GithubAccessDeps = defaultDeps,
): Promise<RepoAccessDTO[]> {
	// A box's projects are a handful; the cap only keeps a runaway caller from
	// sending GitHub thousands of requests in this engine's name.
	const names = [...new Set(repos.filter(isRepoName))].slice(0, MAX_PROBED_REPOS);
	if (names.length === 0) return [];
	let token = await readGitToken(deps);
	if (!token) {
		const gh = await readGhToken(deps);
		token = gh && gh !== "missing" ? gh.token : null;
	}
	const authorization = token
		? `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
		: null;
	const out: RepoAccessDTO[] = new Array(names.length);
	let next = 0;
	const worker = async () => {
		while (next < names.length) {
			const i = next++;
			const repo = names[i] as string;
			out[i] = { repo, access: await probeRepo(repo, authorization, deps) };
		}
	};
	await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, names.length) }, worker));
	return out;
}
