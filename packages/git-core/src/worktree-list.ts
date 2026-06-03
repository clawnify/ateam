import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { GitClient } from "./types";

/**
 * Parsed record for one entry of `git worktree list --porcelain`.
 */
export interface WorktreeRecord {
	/** Path git reports (git already realpath-canonicalizes it). */
	path: string;
	/** HEAD sha, or null for a bare worktree. */
	head: string | null;
	/** Short branch name (no `refs/heads/`), or null when detached/bare. */
	branch: string | null;
	detached: boolean;
	bare: boolean;
	/** Reason string when set (may be empty), else null. */
	locked: { reason: string } | null;
	prunable: { reason: string } | null;
}

function emptyRecord(path: string): WorktreeRecord {
	return {
		path,
		head: null,
		branch: null,
		detached: false,
		bare: false,
		locked: null,
		prunable: null,
	};
}

function shortBranch(ref: string): string {
	const prefix = "refs/heads/";
	return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

/**
 * Parse the porcelain output of `git worktree list --porcelain`. Entries are
 * separated by blank lines; each opens with a `worktree <path>` attribute line.
 * Centralised here so every caller reads worktrees the same way.
 */
export function parseWorktreeList(raw: string): WorktreeRecord[] {
	const records: WorktreeRecord[] = [];
	let record: WorktreeRecord | null = null;

	const commit = () => {
		if (record) records.push(record);
		record = null;
	};

	for (const rawLine of raw.split("\n")) {
		const line = rawLine.replace(/\r$/, "");

		if (line.length === 0) {
			commit();
			continue;
		}

		const sep = line.indexOf(" ");
		const key = sep === -1 ? line : line.slice(0, sep);
		const value = sep === -1 ? "" : line.slice(sep + 1).trim();

		switch (key) {
			case "worktree":
				commit();
				record = emptyRecord(value);
				break;
			case "HEAD":
				if (record) record.head = value || null;
				break;
			case "branch":
				if (record) record.branch = shortBranch(value);
				break;
			case "detached":
				if (record) record.detached = true;
				break;
			case "bare":
				if (record) record.bare = true;
				break;
			case "locked":
				if (record) record.locked = { reason: value };
				break;
			case "prunable":
				if (record) record.prunable = { reason: value };
				break;
			default:
				// Unknown attribute — ignore for forward compatibility.
				break;
		}
	}
	commit();
	return records;
}

/** Run `git worktree list --porcelain` and parse it (never throws). */
export async function listGitWorktrees(
	git: GitClient,
): Promise<WorktreeRecord[]> {
	try {
		return parseWorktreeList(await git.raw(["worktree", "list", "--porcelain"]));
	} catch (err) {
		console.warn("[git-core] git worktree list failed:", err);
		return [];
	}
}

/**
 * Canonicalize a path via realpath when possible, to compare caller paths
 * (which may contain symlinks like macOS `/var` → `/private/var`) against the
 * paths git reports.
 */
export function normalizeWorktreePath(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return resolvePath(path);
	}
}
