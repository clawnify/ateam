import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { GitCoreError } from "./errors";
import { gitFor, refExists } from "./git-client";
import { worktreesRootFor } from "./worktree-paths";

const pexec = promisify(execFile);

export interface GithubRepo {
	owner: string;
	name: string;
}

export interface ProjectInfo {
	/** Absolute path to the repo's primary checkout (== the main worktree). */
	repoPath: string;
	defaultBranch: string;
	/**
	 * The main worktree is the repo's own primary checkout. We never switch its
	 * branch or commit into it — only ever fast-forward it (see merge.ts).
	 */
	mainWorktreePath: string;
	githubRepo: GithubRepo | null;
}

/**
 * Detect the repo's default branch, in order of reliability:
 *   1. `origin/HEAD` symbolic ref (what the remote considers default)
 *   2. `rev-parse --abbrev-ref origin/HEAD`
 *   3. the currently checked-out branch
 *   4. probe `main` then `master`
 */
export async function detectDefaultBranch(repoPath: string): Promise<string> {
	const git = gitFor(repoPath);

	try {
		const ref = (await git.raw(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim();
		if (ref) return ref.replace(/^origin\//, "");
	} catch {
		/* fall through */
	}

	try {
		const ref = (await git.raw(["rev-parse", "--abbrev-ref", "origin/HEAD"])).trim();
		if (ref && ref !== "origin/HEAD") return ref.replace(/^origin\//, "");
	} catch {
		/* fall through */
	}

	try {
		const ref = (await git.raw(["symbolic-ref", "--short", "HEAD"])).trim();
		if (ref) return ref;
	} catch {
		/* fall through */
	}

	for (const candidate of ["main", "master"]) {
		if (await refExists(git, `refs/heads/${candidate}`)) return candidate;
	}

	throw new GitCoreError(
		"NO_DEFAULT_BRANCH",
		`Could not determine the default branch for ${repoPath}`,
	);
}

// github.com/owner/name(.git), over https, ssh:// or scp-style git@github.com:owner/name.
const GITHUB_URL = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;

/** owner/name from a GitHub clone URL, or null when it isn't one. */
export function parseGithubRepo(url: string): GithubRepo | null {
	const m = url.match(GITHUB_URL);
	return m?.[1] && m[2] ? { owner: m[1], name: m[2] } : null;
}

/**
 * The repo's GitHub identity, read from its `origin` URL. This is the only
 * cross-engine-stable identity there is (see the desktop's unify.ts): the same repo
 * cloned on this Mac and on a box is two rows with different paths and different
 * UUIDs, and only owner/name reconciles them into one board card.
 *
 * Deliberately NOT `gh repo view`. That needs gh installed, authed AND online, so a
 * box missing any of the three silently loses its identity; and with no argument it
 * resolves through BaseRepo(), which reports a fork's PARENT. Two engines deriving
 * identity two different ways is exactly what splits one repo into two cards. The
 * origin URL is offline, instant, and the same on every machine that cloned it.
 * Case is normalised by the consumer — GitHub treats owner/name case-insensitively.
 */
export async function detectGithubRepo(repoPath: string): Promise<GithubRepo | null> {
	const url = await getOriginUrl(repoPath);
	return url ? parseGithubRepo(url) : null;
}

/**
 * Compute the top-level path segment to exclude for a worktrees root that lives
 * inside the repo (e.g. `<repo>/.ateam/worktrees` → `/.ateam/`). Returns null
 * when the root is outside the repo (sibling/global), where no exclude applies.
 */
function excludeEntryFor(repoPath: string, worktreesRoot: string): string | null {
	const rel = relative(repoPath, worktreesRoot);
	if (!rel || rel.startsWith("..") || rel.includes(`..${sep}`)) return null;
	const top = rel.split(sep)[0];
	return top ? `/${top}/` : null;
}

/**
 * Append the worktrees dir to the repo's local exclude file
 * (`.git/info/exclude`) so co-located worktrees never show up in the project's
 * own `git status`. Local-only — does not modify the tracked `.gitignore` or
 * dirty the tree. No-op when the worktrees root is outside the repo.
 */
export async function ensureWorktreesIgnored(
	repoPath: string,
	worktreesRoot?: string | null,
): Promise<void> {
	const root = worktreesRootFor(repoPath, worktreesRoot);
	const entry = excludeEntryFor(repoPath, root);
	if (!entry) return; // sibling/global root — nothing to exclude

	const git = gitFor(repoPath);
	let commonDir: string;
	try {
		commonDir = (await git.raw(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
	} catch {
		commonDir = resolve(repoPath, ".git");
	}
	const excludePath = join(commonDir, "info", "exclude");
	try {
		const content = await readFile(excludePath, "utf8").catch(() => "");
		const present = content
			.split("\n")
			.some((line) => line.trim() === entry || line.trim() === entry.slice(1));
		if (present) return;
		await mkdir(dirname(excludePath), { recursive: true });
		const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
		await appendFile(excludePath, `${prefix}${entry}\n`);
	} catch {
		/* best-effort */
	}
}

const DEFAULT_GITIGNORE = `node_modules/
dist/
build/
.DS_Store
*.log
.env
`;

/**
 * Turn a plain folder into a git repository the way GitHub Desktop's
 * "create a repository here instead" does: `git init -b main`, a starter
 * .gitignore (only when none exists), and an initial commit of the current
 * files — worktrees need at least one commit to branch from.
 */
export async function initRepository(repoPath: string): Promise<void> {
	const abs = resolve(repoPath);
	const git = gitFor(abs);

	// Refuse to re-init an existing repo (or a folder inside one).
	try {
		await git.raw(["rev-parse", "--git-dir"]);
		throw new GitCoreError("ALREADY_A_REPO", `${abs} is already inside a git repository`);
	} catch (err) {
		if (err instanceof GitCoreError) throw err;
		/* not a repo — good */
	}

	await git.raw(["init", "-b", "main"]);

	const gitignore = join(abs, ".gitignore");
	try {
		await readFile(gitignore, "utf8");
	} catch {
		await writeFile(gitignore, DEFAULT_GITIGNORE, "utf8");
	}

	await git.raw(["add", "-A"]);
	try {
		await git.raw(["commit", "-m", "Initial commit"]);
	} catch {
		// Nothing staged (empty folder) — still need a commit for worktrees.
		await git.raw(["commit", "--allow-empty", "-m", "Initial commit"]);
	}
}

/** The `origin` remote URL of a repo, or null if it has none (local-only). This is
 *  what decides whether a project can "become available remotely" — a task can run on
 *  a box only if there's a remote to clone it from. */
export async function getOriginUrl(repoPath: string): Promise<string | null> {
	try {
		const url = (await gitFor(repoPath).raw(["remote", "get-url", "origin"])).trim();
		return url || null;
	} catch {
		return null; // no origin remote
	}
}

/** One GitHub repo this machine's `gh` can reach. */
export interface RemoteRepo {
	fullName: string;
	cloneUrl: string;
	private: boolean;
	pushedAt: string;
}

/**
 * The GitHub repos this machine's `gh` can reach, most recently pushed first.
 *
 * `gh api user/repos` rather than `gh repo list`: the latter takes ONE owner and
 * defaults to the authenticated user, so it silently omits every org repo — which
 * for most people is where the actual work is. The `affiliation` filter is what
 * spans both. Returns [] when gh is missing or signed out, exactly as
 * detectGithubRepo used to swallow that case: a picker with no rows is honest,
 * a thrown error in the middle of "add a project" is not.
 */
export async function listRemoteRepos(limit = 100): Promise<RemoteRepo[]> {
	const query = `user/repos?per_page=${limit}&sort=pushed&affiliation=owner,organization_member`;
	try {
		const { stdout } = await pexec("gh", ["api", query]);
		const rows = JSON.parse(stdout) as {
			full_name?: string;
			clone_url?: string;
			private?: boolean;
			pushed_at?: string;
		}[];
		return rows.flatMap((r) =>
			r.full_name && r.clone_url
				? [
						{
							fullName: r.full_name,
							cloneUrl: r.clone_url,
							private: r.private ?? true,
							pushedAt: r.pushed_at ?? "",
						},
					]
				: [],
		);
	} catch {
		return []; // gh missing, signed out, or offline
	}
}

/**
 * Create a GitHub repo FOR an existing local one and set it as `origin`.
 *
 * This is what keeps a brand-new project from being a second-class citizen: with no
 * remote it can never be merged with its copy on another engine (that identity is
 * owner/name, read from `origin`) and can never be provisioned onto a box at all.
 * `name` may be `owner/name` to put it under an org.
 *
 * Throws GH_FAILED so the caller can register the project anyway and report that it
 * has no remote yet — losing the repo because GitHub said no would be worse.
 */
export async function createGithubRepo(
	repoPath: string,
	opts: { name: string; private: boolean },
): Promise<void> {
	try {
		await pexec("gh", [
			"repo",
			"create",
			opts.name,
			"--source",
			resolve(repoPath),
			"--remote",
			"origin",
			"--push",
			opts.private ? "--private" : "--public",
		]);
	} catch (err) {
		throw new GitCoreError(
			"GH_FAILED",
			`Could not create the GitHub repo "${opts.name}" (is gh installed and authenticated on that machine?)`,
			err,
		);
	}
}

/**
 * Clone a repo onto THIS machine from its remote URL, so a task can run here. GitHub
 * URLs go through `gh` (reuses its auth uniformly for private repos); anything else
 * uses plain `git clone`. Used to provision a project onto a remote box. Throws
 * GH_FAILED if the clone fails; `dest` must not already exist.
 */
export async function cloneRepo(cloneUrl: string, dest: string): Promise<void> {
	if (!/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(cloneUrl)) {
		throw new GitCoreError("INVALID_NAME", `Unsupported clone URL "${cloneUrl}"`);
	}
	// A GitHub URL goes through `gh` to reuse its auth for private repos.
	const gh = parseGithubRepo(cloneUrl);
	try {
		if (gh) {
			try {
				await pexec("gh", ["repo", "clone", `${gh.owner}/${gh.name}`, dest]);
			} catch {
				// `gh` may be unauthenticated in this process even when git can
				// clone: hosts like boxd inject GH_TOKEN into login shells only,
				// while wiring a system-scope git credential helper that works
				// from any process. Fall back to plain `git clone`.
				await rm(dest, { recursive: true, force: true });
				await pexec("git", ["clone", cloneUrl, dest]);
			}
		} else {
			await pexec("git", ["clone", cloneUrl, dest]);
		}
	} catch (err) {
		throw new GitCoreError(
			"GH_FAILED",
			`Could not clone ${cloneUrl} (is git/gh installed and authenticated on that machine?)`,
			err,
		);
	}
}

export async function registerProject(repoPath: string): Promise<ProjectInfo> {
	const abs = resolve(repoPath);
	const git = gitFor(abs);
	try {
		await git.raw(["rev-parse", "--git-dir"]);
	} catch (err) {
		throw new GitCoreError("NOT_A_REPO", `${abs} is not a git repository`, err);
	}

	const defaultBranch = await detectDefaultBranch(abs);
	const githubRepo = await detectGithubRepo(abs);
	await ensureWorktreesIgnored(abs);

	return {
		repoPath: abs,
		defaultBranch,
		mainWorktreePath: abs,
		githubRepo,
	};
}
