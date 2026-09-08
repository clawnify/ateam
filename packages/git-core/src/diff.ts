import { open } from "node:fs/promises";
import { join } from "node:path";
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

/**
 * Line count + binary-ness of a file on disk, the way `git diff --numstat`
 * would report it once added: a trailing partial line counts, and a NUL byte
 * in the first 8000 bytes means binary (git's own heuristic). Streamed, so a
 * stray large untracked file costs I/O, not memory.
 */
async function countNewFile(absPath: string): Promise<{ additions: number; binary: boolean }> {
	const fh = await open(absPath, "r");
	try {
		const buf = Buffer.alloc(64 * 1024);
		let lines = 0;
		let first = true;
		let lastByte = -1;
		for (;;) {
			const { bytesRead } = await fh.read(buf, 0, buf.length, null);
			if (bytesRead === 0) break;
			const chunk = buf.subarray(0, bytesRead);
			if (first) {
				first = false;
				if (chunk.subarray(0, 8000).includes(0)) return { additions: 0, binary: true };
			}
			for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) lines++;
			lastByte = chunk[bytesRead - 1] ?? lastByte;
		}
		if (lastByte !== -1 && lastByte !== 10) lines++;
		return { additions: lines, binary: false };
	} finally {
		await fh.close();
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
			await safeRaw(git, ["diff", "--numstat", "--merge-base", `origin/${input.baseBranch}`]),
			files,
		);
	}
	parseNumstatInto(await safeRaw(git, ["diff", "--numstat", "--staged"]), files);
	parseNumstatInto(await safeRaw(git, ["diff", "--numstat"]), files);

	// Untracked files never appear in `git diff`; list them explicitly, with
	// every line counted as an addition (what staging them would report).
	const untracked = await safeRaw(git, ["ls-files", "--others", "--exclude-standard"]);
	for (const line of untracked.split("\n")) {
		const path = line.trim();
		if (!path || files.has(path)) continue;
		const counted = await countNewFile(join(input.worktreePath, path)).catch(() => ({
			additions: 0,
			binary: false,
		}));
		files.set(path, {
			path,
			...counted,
			deletions: 0,
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
	const patch = input.baseBranch
		? await safeRaw(git, ["diff", "--merge-base", `origin/${input.baseBranch}`, "--", input.file])
		: await safeRaw(git, ["diff", "--", input.file]);
	if (patch) return patch;

	// `git diff` is silent on an untracked file (an agent's freshly created
	// file that nothing staged yet). Diff it against nothing instead, which
	// yields a regular "new file" patch. `--no-index` exits 1 on any difference
	// with nothing on stderr, which simple-git reports as success.
	const isUntracked = (
		await safeRaw(git, ["ls-files", "--others", "--exclude-standard", "--", input.file])
	).trim();
	if (!isUntracked) return patch;
	return safeRaw(git, ["diff", "--no-index", "--", "/dev/null", input.file]);
}
