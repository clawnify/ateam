import { open } from "node:fs/promises";
import { join } from "node:path";
import type { SimpleGit } from "simple-git";
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
 * Paths whose committed changes are already on `origin/<base>`: merging HEAD
 * into base right now would leave each of them exactly as base has it.
 *
 * The merge-base diff can't see this. A squash or rebase merge lands the
 * branch's changes as NEW commits, so the branch tip never becomes an ancestor
 * of base, the merge-base never moves, and every line the branch ever added
 * keeps counting after its PR merged. Asking git what the merge would still
 * contribute answers it from content alone: whatever the merge style, whatever
 * the branch is called, and even after base edits the same files again.
 *
 * `merge-tree --write-tree` (git >= 2.38) merges in memory: no index, no
 * working tree, no lock an agent could trip over. A conflicted path counts as
 * still contributing, so it keeps the merge-base numbers it had before this
 * existed. Returns null when git can't answer (older git, no `origin/<base>`),
 * and callers then keep the merge-base numbers for everything.
 */
async function landedPaths(git: SimpleGit, baseBranch: string): Promise<Set<string> | null> {
	const base = `origin/${baseBranch}`;
	let merged: string;
	try {
		// Exit 1 (conflicts) arrives here as output: with --no-messages git
		// writes nothing to stderr, which simple-git reports as success.
		merged = await git.raw([
			"merge-tree",
			"--write-tree",
			"--name-only",
			"--no-messages",
			base,
			"HEAD",
		]);
	} catch {
		return null;
	}
	const [tree, ...conflicted] = merged.split("\n").filter(Boolean);
	if (!tree || !/^[0-9a-f]{40,64}$/.test(tree)) return null;

	const nameOnly = (raw: string) => raw.split("\n").filter(Boolean);
	const committed = nameOnly(
		await safeRaw(git, ["diff", "--name-only", "--merge-base", base, "HEAD"]),
	);
	if (committed.length === 0) return new Set();
	const stillContributing = new Set(
		nameOnly(await safeRaw(git, ["diff", "--name-only", base, tree])),
	);
	const conflicts = new Set(conflicted);
	const landed = new Set(
		committed.filter((path) => !stillContributing.has(path) && !conflicts.has(path)),
	);

	// A file that landed and was then edited again on base conflicts above
	// whenever the merge can't line the two up: a file the branch created
	// (add/add), or base rewriting the very lines the branch wrote. Those
	// count as landed when base, at some commit since the fork, held exactly
	// HEAD's version of the file.
	const recheck = committed.filter((path) => conflicts.has(path));
	if (recheck.length > 0) {
		const headBlobs = new Map<string, string>();
		for (const line of (await safeRaw(git, ["ls-tree", "HEAD", "--", ...recheck])).split("\n")) {
			const m = /^\S+ blob (\S+)\t(.+)$/.exec(line);
			if (m?.[1] && m[2]) headBlobs.set(m[2], m[1]);
		}
		// `--raw` lines read ":<mode> <mode> <old blob> <new blob> <status>\t<path>".
		const onBase = await safeRaw(git, [
			"log",
			"--no-renames",
			"--no-abbrev",
			"--format=",
			"--raw",
			base,
			"^HEAD",
			"--",
			...recheck,
		]);
		for (const line of onBase.split("\n")) {
			const m = /^:\S+ \S+ \S+ (\S+) \S+\t(.+)$/.exec(line);
			if (m?.[1] && m[2] && headBlobs.get(m[2]) === m[1]) landed.add(m[2]);
		}
	}
	return landed;
}

/**
 * The combined set of changed files for the diff viewer: everything the branch
 * still contributes to its base, committed or not, plus untracked files.
 *
 * With a base, `diff --merge-base origin/<base>` compares the merge-base with
 * the WORKING TREE, so one pass already covers committed, staged and unstaged
 * edits. Files that already landed (see `landedPaths`) count only the work
 * done on top of HEAD since. Without a base, or when `origin/<base>` is
 * missing, it falls back to staged plus unstaged changes.
 * All reads, all scoped to this worktree.
 */
export async function diff(input: DiffInput): Promise<DiffResult> {
	const git = gitFor(input.worktreePath);
	const files = new Map<string, DiffFile>();

	let againstBase = false;
	if (input.baseBranch) {
		try {
			parseNumstatInto(
				await git.raw(["diff", "--numstat", "--merge-base", `origin/${input.baseBranch}`]),
				files,
			);
			againstBase = true;
		} catch {
			/* no origin/<base> to compare with: fall through to local changes */
		}
	}
	if (againstBase && input.baseBranch) {
		const landed = await landedPaths(git, input.baseBranch);
		if (landed && landed.size > 0) {
			for (const path of landed) files.delete(path);
			const sinceHead = new Map<string, DiffFile>();
			parseNumstatInto(await safeRaw(git, ["diff", "--numstat", "HEAD"]), sinceHead);
			for (const [path, file] of sinceHead) if (landed.has(path)) files.set(path, file);
		}
	} else {
		// Later sources win on path collisions so counts reflect the working tree.
		parseNumstatInto(await safeRaw(git, ["diff", "--numstat", "--staged"]), files);
		parseNumstatInto(await safeRaw(git, ["diff", "--numstat"]), files);
	}

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
	// A file that already landed on base shows only what changed since HEAD,
	// matching the counts `diff` reports for it.
	const landed = input.baseBranch ? await landedPaths(git, input.baseBranch) : null;
	const patch =
		input.baseBranch && !landed?.has(input.file)
			? await safeRaw(git, ["diff", "--merge-base", `origin/${input.baseBranch}`, "--", input.file])
			: await safeRaw(git, ["diff", ...(landed ? ["HEAD"] : []), "--", input.file]);
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
