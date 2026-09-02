/**
 * Session search — the engine-side entry point.
 *
 * Scope: sessions that ran in a task's worktree. That keeps every result
 * clickable (a hit always maps back to a task, and usually to the exact
 * terminal tab that produced it) and keeps other projects' history out of a
 * project-scoped board. A task removed by cleanup takes its history out of the
 * index with it — widening to "every transcript under the repo" is a change to
 * `worktrees()` alone.
 *
 * Two stages, for reasons measured on this repo's own 1GB of transcripts:
 * ranking first and asking the model second is faster, ~20x cheaper, and MORE
 * accurate than one big prompt. See rank.ts and rerank.ts.
 */
import { repo, type Task } from "@ateam/db";
import type { SessionHitDTO } from "@ateam/protocol";
import type { Services } from "../services";
import { type RankInput, rank } from "./rank";
import { askAgent, buildPrompt, expandQuery, parseVerdicts } from "./rerank";
import { claudeSource } from "./sources/claude";
import { codexSource } from "./sources/codex";
import { opencodeSource } from "./sources/opencode";
import type { RankedSession, SessionDigest } from "./types";

/** How many candidates the model is asked to judge. Enough to contain the
 *  answer, few enough that it reads every one. */
const SHORTLIST = 20;
/** How many hits reach the UI. */
const RESULTS = 8;

/**
 * How long a built index is reused before the stores are checked again. The
 * rebuild behind it is nearly free: each source memoizes its parsed digests by
 * path+mtime, so a rebuild stats the files and re-reads only the session you
 * are still in. The memo lives for the life of the process rather than on disk
 * — persist it only if a cold first search ever becomes the complaint.
 */
const TTL_MS = 60_000;

const SOURCES = [claudeSource(), codexSource(), opencodeSource()];

interface CacheEntry {
	at: number;
	digests: SessionDigest[];
}
const cache = new Map<string, CacheEntry>();

async function buildIndex(worktrees: string[]): Promise<SessionDigest[]> {
	const lists = await Promise.all(
		SOURCES.map(async (source) => {
			try {
				return await source.digestsFor(worktrees);
			} catch {
				// One harness's store being unreadable must not hide the others.
				return [];
			}
		}),
	);
	return lists.flat();
}

export interface SessionSearchInput {
	projectId: string;
	query: string;
	/** Run the model re-rank. Off = the lexical answer alone.
	 *  The desktop only ever asks with `ai: true`: typing is answered from the
	 *  tasks already in the window (name, branch, description), and reading the
	 *  transcripts is what the "find the session that did this" row buys. */
	ai?: boolean;
	/** Which agent answers the re-rank; defaults to the configured agent. */
	agentId?: string;
}

export async function searchSessions(
	services: Services,
	input: SessionSearchInput,
): Promise<SessionHitDTO[]> {
	const { db } = services;
	const query = input.query.trim();
	if (!query) return [];

	const tasks = repo.listTasks(db, input.projectId);
	if (tasks.length === 0) return [];
	const byWorktree = new Map(tasks.map((t) => [t.worktreePath, t]));

	const cached = cache.get(input.projectId);
	const digests =
		cached && Date.now() - cached.at < TTL_MS
			? cached.digests
			: await buildIndex([...byWorktree.keys()]);
	cache.set(input.projectId, { at: Date.now(), digests });

	// Resolve against the CURRENT tasks, not the cached ones: a task removed
	// since the index was built drops out of the results immediately rather
	// than lingering for the rest of the TTL.
	const inputs: RankInput[] = [];
	for (const digest of digests) {
		const task = byWorktree.get(digest.cwd);
		if (!task) continue;
		inputs.push({ digest, titles: [task.name, task.branch] });
	}

	if (!input.ai) {
		return toHits(services, rank(inputs, query, RESULTS), byWorktree, new Map());
	}

	// The AI pass: widen the vocabulary, rank, then let the model read the
	// shortlist. Expansion first, because a shortlist that never contained the
	// answer cannot be re-ranked into containing it.
	//
	// It is skipped when the user's own words already fill the shortlist: those
	// are the queries where expansion changes nothing, and each model call costs
	// several seconds of a click the user is waiting on.
	const agentId = input.agentId ?? repo.getSettings(db).defaultAgentId ?? "claude";
	const typedOnly = rank(inputs, query, SHORTLIST);
	const ranked =
		typedOnly.length >= SHORTLIST
			? typedOnly
			: rank(inputs, query, SHORTLIST, { expansions: await expandQuery(agentId, query) });
	if (ranked.length === 0) return [];

	const why = new Map<string, string>();
	let ordered = ranked;
	{
		const labels = new Map(
			ranked.map((r) => [r.digest.sessionId, byWorktree.get(r.digest.cwd)?.name ?? ""]),
		);
		const reply = await askAgent(agentId, buildPrompt(query, ranked, labels));
		const verdicts = parseVerdicts(reply, new Set(ranked.map((r) => r.digest.sessionId)));
		if (verdicts.length > 0) {
			const rankOf = new Map(verdicts.map((v, i) => [v.sessionId, i]));
			for (const v of verdicts) why.set(v.sessionId, v.why);
			// The model's picks lead, in its order; the rest keep the lexical
			// order behind them rather than disappearing, so a model that missed
			// the answer never hides a result the user can still recognise.
			ordered = [...ranked].sort(
				(a, b) =>
					(rankOf.get(a.digest.sessionId) ?? Number.MAX_SAFE_INTEGER) -
					(rankOf.get(b.digest.sessionId) ?? Number.MAX_SAFE_INTEGER),
			);
		}
	}

	return toHits(services, ordered.slice(0, RESULTS), byWorktree, why);
}

/** Join ranked digests back to their tasks and terminals for the UI. */
function toHits(
	services: Services,
	ranked: RankedSession[],
	byWorktree: Map<string, Task>,
	why: Map<string, string>,
): SessionHitDTO[] {
	const hits: SessionHitDTO[] = [];
	for (const r of ranked) {
		const task = byWorktree.get(r.digest.cwd);
		if (!task) continue;
		const terminalId = repo.findTerminalByAgentSessionId(services.db, r.digest.sessionId) ?? null;
		hits.push({
			sessionId: r.digest.sessionId,
			agentId: r.digest.agentId,
			taskId: task.id,
			taskName: task.name,
			branch: task.branch ?? r.digest.branch ?? null,
			// Only offer a terminal that still exists — a tab from a previous run
			// of the app is a dead id, and opening it would show an empty panel.
			terminalId: terminalId && services.pty.has(terminalId) ? terminalId : null,
			startedAt: r.digest.startedAt,
			endedAt: r.digest.endedAt,
			excerpt: r.excerpts[0] ?? "",
			why: why.get(r.digest.sessionId) ?? null,
		});
	}
	return hits;
}
