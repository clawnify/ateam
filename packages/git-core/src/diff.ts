import { gitFor, safeRaw } from "./git-client";

export interface DiffFile {
	path: string;
	additions: number;
	deletions: number;
	binary: boolean;
	/** New file not yet tracked by git (won't show in `git diff`). */
	untracked: boolean;
}

export interface DiffResult {
	baseBranch: string | null;
	files: DiffFile[];
}

function parseNumstatInto(raw: string, into: Map<string, DiffFile>): void {
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		const parts = line.split("\t");
		if (parts.length < 3) continue;
		const [addsRaw, delsRaw, ...pathParts] = parts;
		let path = pathParts.join("\t");
		// Renames render as "old => new" or "dir/{old => new}/file".
		const arrow = path.indexOf(" => ");
		if (arrow !== -1) {
			path = path
				.replace(/\{.*? => (.*?)\}/g, "$1")
				.replace(/^.*? => /, "")
				.trim();
		}
		const binary = addsRaw === "-" || delsRaw === "-";
		into.set(path, {
			path,
			additions: binary ? 0 : Number.parseInt(addsRaw ?? "0", 10) || 0,
			deletions: binary ? 0 : Number.parseInt(delsRaw ?? "0", 10) || 0,
			binary,
			untracked: false,
		});
	}
}

export interface DiffInput {
	worktreePath: string;
	/** When provided, includes committed changes vs `origin/<base>` merge-base. */
	baseBranch?: string;
}

/**
 * The combined set of changed files for the diff viewer: committed changes vs
 * the base merge-base (if a base is given) plus staged and unstaged changes.
 * Later sources win on path collisions so counts reflect the working tree.
 * All reads, all scoped to this worktree.
 */
export async function diff(input: DiffInput): Promise<DiffResult> {
	const git = gitFor(input.worktreePath);
	const files = new Map<string, DiffFile>();

	if (input.baseBranch) {
		parseNumstatInto(
			await safeRaw(git, [
				"diff",
				"--numstat",
				"--merge-base",
				`origin/${input.baseBranch}`,
			]),
			files,
		);
	}
	parseNumstatInto(await safeRaw(git, ["diff", "--numstat", "--staged"]), files);
	parseNumstatInto(await safeRaw(git, ["diff", "--numstat"]), files);

	// Untracked files never appear in `git diff`; list them explicitly.
	const untracked = await safeRaw(git, [
		"ls-files",
		"--others",
		"--exclude-standard",
	]);
	for (const line of untracked.split("\n")) {
		const path = line.trim();
		if (!path || files.has(path)) continue;
		files.set(path, {
			path,
			additions: 0,
			deletions: 0,
			binary: false,
			untracked: true,
		});
	}

	return {
		baseBranch: input.baseBranch ?? null,
		files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
	};
}

export interface FileDiffInput {
	worktreePath: string;
	file: string;
	baseBranch?: string;
}

/** The unified patch for a single file (lazily fetched by the viewer). */
export async function fileDiff(input: FileDiffInput): Promise<string> {
	const git = gitFor(input.worktreePath);
	if (input.baseBranch) {
		return safeRaw(git, [
			"diff",
			"--merge-base",
			`origin/${input.baseBranch}`,
			"--",
			input.file,
		]);
	}
	return safeRaw(git, ["diff", "--", input.file]);
}
