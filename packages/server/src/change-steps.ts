// A task's diff told as steps, for reviewing a big change: the steps someone
// would use to explain it, the agent's reason for each, and whatever in the diff
// the agent's own account of the work never mentions.
//
// WHO WRITES THEM. Not the task's agent. A second reader does, from what the
// agent already said: an author can't point out what it left out of its own
// account, and that list is the part review can't get anywhere else (tested on
// five merged PRs, 2026-11-03: two had a security-relevant change the agent never
// mentioned, a safety flag moved and a new token permission). It runs on the
// task's own agent CLI, headless, so the code goes nowhere it hasn't already
// been: never through OpenRouter. Claude runs Sonnet, which was both faster
// (17s against Haiku's 37-51s on 115KB) and the only one to catch the safety
// flag. Codex runs the user's default model (its model ids differ per account).
// OpenCode is left out: it takes the prompt on the command line, and a diff this
// size passes Linux's limit for one argument.
//
// WHAT THEY READ. The diff (files and patches, live from git) and the agent's
// account: every turn since the task's work last landed (its newest merged PR),
// what the user asked and what the agent replied when each turn ended. Not just
// the last reply: one task can ship several PRs, and an account covering part of
// the diff flagged 10 to 28 files that were fine.
//
// WHEN. On demand, when the Changes view asks for a diff of STEPS_MIN_FILES or
// more, and kept per task against a key of the diff (files and line counts). The
// same diff is answered from the table; a changed one starts a new write and
// answers with the old steps marked out of date. Nothing runs for a task nobody
// reviews, and a turn that changed no code costs nothing.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { type AteamDb, type ChangeStepsBody, repo, type Task } from "@ateam/db";
import type { DiffFile } from "@ateam/git-core";
import { CHANGE_STEPS_MIN_FILES, type ChangeStepsDTO } from "@ateam/protocol";
import type { TurnEntry } from "./session-search/types";

/** Fewer files than this read fine as a flat list (shared with the client). */
export const STEPS_MIN_FILES = CHANGE_STEPS_MIN_FILES;
/** Agents whose headless call can take a whole diff (see the header). */
export const STEPS_AGENTS = new Set(["claude", "codex"]);
/** Claude's model for the job; other agents keep their own default. */
export const STEPS_MODEL = "sonnet";
/** Measured 17s on a 115KB prompt; room for a slow day and a bigger diff. */
export const STEPS_TIMEOUT_MS = 120_000;
/** One at a time: a headless Claude peaks near 300MB, and a box is often small. */
const MAX_IN_FLIGHT = 1;
/** A diff whose write failed is tried again after this, or once it changes. */
const RETRY_AFTER_MS = 10 * 60_000;
/** Budgets for the prompt. The patch is the bulk: 43-108KB on the PRs tested. */
export const MAX_PATCH_CHARS = 110_000;
export const MAX_ACCOUNT_CHARS = 30_000;
const MAX_ASKED_CHARS = 6_000;
const MAX_STEPS = 8;

/**
 * Names a diff by its files and line counts, order-blind. Two diffs with the
 * same files and counts share a key even if a line changed in place; the next
 * edit that moves a count makes the steps out of date again.
 */
export function diffKey(files: DiffFile[]): string {
	const lines = files
		.map((f) => `${f.path}\t${f.additions}\t${f.deletions}\t${f.binary ? 1 : 0}`)
		.sort();
	return createHash("sha1").update(lines.join("\n")).digest("hex");
}

/** Keep the newest entries that fit in `max` characters, oldest first. */
function newestWithin(texts: string[], max: number): string[] {
	const kept: string[] = [];
	let used = 0;
	for (let i = texts.length - 1; i >= 0; i--) {
		const t = texts[i] ?? "";
		if (used + t.length > max) break;
		kept.unshift(t);
		used += t.length;
	}
	return kept;
}

/** The agent's account from its turns: what the user asked, what it replied. */
export function accountFrom(turns: TurnEntry[]): { asked: string[]; replies: string[] } {
	return {
		asked: newestWithin(
			turns.filter((t) => t.role === "user").map((t) => t.text),
			MAX_ASKED_CHARS,
		),
		replies: newestWithin(
			turns.filter((t) => t.role === "agent").map((t) => t.text),
			MAX_ACCOUNT_CHARS,
		),
	};
}

/**
 * The patches joined within `max` characters. When they don't fit, each file
 * gets an equal share, files smaller than their share give the rest back, and
 * the big ones are cut with a note, so one generated file can't crowd out every
 * other file's patch. The model still sees every file in the list with its
 * counts. Returns the paths that were cut.
 */
export function patchText(
	patches: { path: string; patch: string }[],
	max = MAX_PATCH_CHARS,
): { text: string; clipped: string[] } {
	const total = patches.reduce((n, p) => n + p.patch.length, 0);
	if (total <= max) return { text: patches.map((p) => p.patch).join("\n"), clipped: [] };
	const share = new Map<string, number>();
	let left = max;
	let open = [...patches].sort((a, b) => a.patch.length - b.patch.length);
	while (open.length > 0) {
		const each = Math.floor(left / open.length);
		const small = open.filter((p) => p.patch.length <= each);
		if (small.length === 0) {
			for (const p of open) share.set(p.path, each);
			break;
		}
		for (const p of small) {
			share.set(p.path, p.patch.length);
			left -= p.patch.length;
		}
		open = open.filter((p) => p.patch.length > each);
	}
	const clipped: string[] = [];
	const parts = patches.map((p) => {
		const keep = share.get(p.path) ?? p.patch.length;
		if (p.patch.length <= keep) return p.patch;
		clipped.push(p.path);
		const cut = p.patch.slice(0, keep);
		return `${cut.slice(0, cut.lastIndexOf("\n") + 1)}[… the rest of ${p.path}'s patch is not shown]\n`;
	});
	return { text: parts.join("\n"), clipped };
}

/** The prompt, as tested on #385, #375, #402 and #407 (2026-11-03). */
export function buildStepsPrompt(input: {
	asked: string[];
	replies: string[];
	files: DiffFile[];
	patch: string;
	clipped: string[];
}): string {
	const files = input.files
		.map((f) => `${f.path} ${f.binary ? "(binary)" : `+${f.additions} -${f.deletions}`}`)
		.join("\n");
	return [
		"You are preparing a code review aid. Below is a change an agent made: what the user asked, the agent's own report of its work, the list of changed files, and the diff.",
		"",
		"Split the change into LAYERS: the steps a developer would use to explain it, in the order they would explain them (usually the contract or data first, then the logic, then the UI, then anything else). Group by meaning, not by folder. A layer usually spans several files. A file may appear in two layers if different parts of it serve different steps. Tests go in the layer they prove, never a layer of their own.",
		"",
		"For each layer:",
		'- "title": 3 to 7 words.',
		`- "why": one or two plain sentences on why this step was needed, taken from the agent's report. Never invent a reason. If the report gives none, write exactly "The report doesn't say why."`,
		'- "files": each file in this layer with "path" and "note": one short sentence on what changed in that file for this step.',
		"",
		'Then "unexplained": every change the report does not mention or account for, with "path" and "note". Drive-by edits, refactors, renamed things, and files that change behaviour without a word in the report belong here. Leave it empty if everything is covered.',
		"",
		`Every changed file must appear at least once, in a layer or under unexplained, with its path exactly as listed. Keep the language plain. Use 2 to ${MAX_STEPS - 2} layers.`,
		"",
		"Reply with ONLY this JSON, no prose, no code fence:",
		'{"layers":[{"title":"","why":"","files":[{"path":"","note":""}]}],"unexplained":[{"path":"","note":""}]}',
		"",
		"=== WHAT THE USER ASKED (in order) ===",
		input.asked.length ? input.asked.join("\n---\n") : "(nothing recorded)",
		"",
		"=== THE AGENT'S REPORT OF ITS WORK ===",
		input.replies.length ? input.replies.join("\n\n---\n\n") : "(no report was found)",
		"",
		"=== CHANGED FILES (+added -deleted) ===",
		files,
		...(input.clipped.length
			? ["", `(The patches of ${input.clipped.length} large files are cut short below.)`]
			: []),
		"",
		"=== DIFF ===",
		input.patch,
	].join("\n");
}

/** A path as the model wrote it, as git lists it. */
function normalizePath(p: unknown): string {
	return typeof p === "string"
		? p
				.trim()
				.replace(/^\.\//, "")
				.replace(/^[ab]\//, "")
		: "";
}

function noteOf(v: unknown): string {
	return typeof v === "string" ? v.trim() : "";
}

/**
 * The model's reply as steps, or null when it can't be trusted: not JSON in the
 * agreed shape, a path that isn't in the diff (an invented one), or a changed
 * file it left out. A partial answer would hide exactly the file a reviewer
 * needed, so it is all or nothing.
 */
export function parseSteps(raw: string, paths: string[]): ChangeStepsBody | null {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return null;
	}
	const o = parsed as { layers?: unknown; unexplained?: unknown };
	if (!Array.isArray(o.layers) || o.layers.length === 0 || o.layers.length > MAX_STEPS) return null;
	const known = new Set(paths);
	const covered = new Set<string>();
	const files = (list: unknown): { path: string; note: string }[] | null => {
		if (!Array.isArray(list)) return null;
		const out: { path: string; note: string }[] = [];
		for (const f of list) {
			const path = normalizePath((f as { path?: unknown })?.path);
			if (!known.has(path)) return null;
			if (out.some((x) => x.path === path)) continue;
			covered.add(path);
			out.push({ path, note: noteOf((f as { note?: unknown }).note) });
		}
		return out;
	};
	const steps: ChangeStepsBody["steps"] = [];
	for (const l of o.layers) {
		const layer = l as { title?: unknown; why?: unknown; files?: unknown };
		const title = noteOf(layer.title);
		const list = files(layer.files);
		if (!title || !list || list.length === 0) return null;
		steps.push({ title, why: noteOf(layer.why), files: list });
	}
	const unexplained = o.unexplained === undefined ? [] : files(o.unexplained);
	if (!unexplained) return null;
	if (paths.some((p) => !covered.has(p))) return null;
	return { steps, unexplained };
}

const pexec = promisify(execFile);

/**
 * When the newest merged PR from `branch` landed. Ateam keeps no merge time of
 * its own (task-triage.ts), and a task that kept going after a merge has turns
 * about work that already landed, which the diff no longer shows. Null with no
 * merged PR, no GitHub remote, or no `gh`: the account then starts at the
 * task's first turn.
 */
export async function lastMergedPrAt(worktreePath: string, branch: string): Promise<number | null> {
	try {
		const { stdout } = await pexec(
			"gh",
			["pr", "list", "--head", branch, "--state", "merged", "--json", "mergedAt", "--limit", "20"],
			{ cwd: worktreePath, timeout: 15_000 },
		);
		const times = (JSON.parse(stdout) as { mergedAt?: string | null }[])
			.map((p) => (p.mergedAt ? Date.parse(p.mergedAt) : Number.NaN))
			.filter(Number.isFinite);
		return times.length ? Math.max(...times) : null;
	} catch {
		return null;
	}
}

export interface ChangeStepsDeps {
	db: AteamDb;
	/** The task's changed files, as the flat list shows them. */
	diffOf(task: Task): Promise<DiffFile[]>;
	/** Each file's patch, as the file diff view shows it. */
	patchesOf(task: Task, paths: string[]): Promise<{ path: string; patch: string }[]>;
	/** The task's turns from `since` on (all of them for null). */
	turnsOf(task: Task, since: number | null): Promise<TurnEntry[]>;
	/** When the task's newest merged PR landed; null with none (or no GitHub). */
	lastMergeAt(task: Task): Promise<number | null>;
	/** One headless call on `agentId`; "" on any failure. */
	ask(agentId: string, prompt: string): Promise<string>;
	now?: () => number;
}

export interface ChangeSteps {
	get(taskId: string): Promise<ChangeStepsDTO>;
	/** A write is running: keeps a box awake (engine.isWorking). */
	busy(): boolean;
}

export function createChangeSteps(deps: ChangeStepsDeps): ChangeSteps {
	const now = deps.now ?? Date.now;
	/** task id → the diff key being written for it. */
	const inFlight = new Map<string, string>();
	/** task id → the diff key whose write failed, and when. */
	const failed = new Map<string, { key: string; at: number }>();

	const write = async (task: Task, key: string, files: DiffFile[], agentId: string) => {
		inFlight.set(task.id, key);
		try {
			const since = await deps.lastMergeAt(task).catch(() => null);
			const turns = await deps.turnsOf(task, since).catch(() => []);
			const account = accountFrom(turns);
			// No transcript to read (a harness that keeps none we can parse): the
			// last turn's reply, which Ateam keeps from the Stop hook, is all there is.
			if (account.replies.length === 0 && task.lastReply) account.replies.push(task.lastReply);
			const text = files.filter((f) => !f.binary).map((f) => f.path);
			const { text: patch, clipped } = patchText(await deps.patchesOf(task, text));
			const raw = await deps.ask(agentId, buildStepsPrompt({ ...account, files, patch, clipped }));
			const body = raw
				? parseSteps(
						raw,
						files.map((f) => f.path),
					)
				: null;
			if (!body) {
				failed.set(task.id, { key, at: now() });
				return;
			}
			failed.delete(task.id);
			// Deleted while the model was writing: nothing to keep.
			if (!repo.getTask(deps.db, task.id)) return;
			repo.setChangeSteps(deps.db, task.id, { diffKey: key, body, madeAt: now() });
		} catch {
			failed.set(task.id, { key, at: now() });
		} finally {
			inFlight.delete(task.id);
		}
	};

	return {
		async get(taskId) {
			const task = repo.getTask(deps.db, taskId);
			if (!task) throw new Error(`Task not found: ${taskId}`);
			const stored = repo.getChangeSteps(deps.db, taskId);
			const answer = (over: Partial<ChangeStepsDTO>): ChangeStepsDTO => ({
				steps: stored?.body.steps ?? null,
				unexplained: stored?.body.unexplained ?? [],
				current: false,
				madeAt: stored?.madeAt ?? null,
				working: false,
				unavailable: null,
				...over,
			});
			// Polled while it runs: answer without reading the diff again.
			if (inFlight.has(taskId)) return answer({ working: true });

			const files = await deps.diffOf(task);
			if (files.length < STEPS_MIN_FILES) return answer({ unavailable: "small" });
			const agentId = task.agentId ?? "claude";
			if (!STEPS_AGENTS.has(agentId)) return answer({ unavailable: "agent" });
			const key = diffKey(files);
			if (stored?.diffKey === key) return answer({ current: true });
			const f = failed.get(taskId);
			if (f?.key === key && now() - f.at < RETRY_AFTER_MS) return answer({ unavailable: "failed" });
			// At capacity: say it's coming, and the next poll starts it.
			if (inFlight.size < MAX_IN_FLIGHT) void write(task, key, files, agentId);
			return answer({ working: true });
		},
		busy: () => inFlight.size > 0,
	};
}
