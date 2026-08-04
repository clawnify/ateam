import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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

async function detectGithubRepo(repoPath: string): Promise<GithubRepo | null> {
	try {
		const { stdout } = await pexec("gh", ["repo", "view", "--json", "owner,name"], {
			cwd: repoPath,
		});
		const parsed = JSON.parse(stdout) as {
			owner?: { login?: string };
			name?: string;
		};
		if (parsed.owner?.login && parsed.name) {
			return { owner: parsed.owner.login, name: parsed.name };
		}
	} catch {
		/* gh missing, not authed, or not a GitHub remote — fine, local-only */
	}
	return null;
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
	// github.com/owner/name(.git) — capture owner/name to prefer `gh` (auth) for GitHub.
	const gh = cloneUrl.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
	try {
		if (gh) {
			await pexec("gh", ["repo", "clone", `${gh[1]}/${gh[2]}`, dest]);
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
