// Worktree path resolution. Worktrees are co-located under `<repo>/.ateam/
// worktrees` (see defaultWorktreesRoot); `safeResolveWorktreePath` is the
// security-critical guard against path traversal.
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { GitCoreError } from "./errors";

/**
 * Co-located, agent-neutral default: worktrees live under `<repo>/.ateam/
 * worktrees` so each agent (Claude Code, OpenCode, Codex) finds the worktree
 * root and its project config (CLAUDE.md / AGENTS.md / opencode.json travel via
 * checkout), while staying out of a far-off global dir. A worktree is per-task,
 * not per-agent — one location serves whichever agent you launch. Excluded from
 * the repo's own status via `.git/info/exclude` (see ensureWorktreesIgnored).
 */
export function defaultWorktreesRoot(repoPath: string): string {
	return join(repoPath, ".ateam", "worktrees");
}

export function normalizeWorktreeBaseDir(
	input: string | null | undefined,
): string | null {
	const trimmed = input?.trim();
	if (!trimmed) return null;

	if (trimmed.startsWith("~")) {
		const rest = trimmed.slice(1);
		if (rest === "" || rest.startsWith("/") || rest.startsWith("\\")) {
			return normalize(join(homedir(), rest));
		}
	}

	if (!isAbsolute(trimmed)) {
		throw new GitCoreError(
			"INVALID_NAME",
			"Worktree location must be an absolute path or start with ~",
		);
	}

	return resolve(trimmed);
}

/** The root directory under which a project's worktrees are created. */
export function worktreesRootFor(
	repoPath: string,
	override?: string | null,
): string {
	return resolve(override ?? defaultWorktreesRoot(repoPath));
}

/**
 * Resolve a worktree path for `slug`, guarding against path traversal
 * (`../`, absolute escapes). Throws PATH_TRAVERSAL if the resolved path would
 * escape the worktrees root.
 */
export function safeResolveWorktreePath(
	repoPath: string,
	slug: string,
	override?: string | null,
): string {
	const root = worktreesRootFor(repoPath, override);
	const worktreePath = resolve(root, slug);
	if (worktreePath !== root && !worktreePath.startsWith(root + sep)) {
		throw new GitCoreError(
			"PATH_TRAVERSAL",
			`Invalid task name: path traversal detected (${slug})`,
		);
	}
	return worktreePath;
}
