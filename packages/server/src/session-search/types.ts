/**
 * Session search — "which session was I working on X?" answered inside the app,
 * instead of opening a fresh agent session just to ask.
 *
 * The corpus is every past agent session that belongs to a task: each harness
 * writes its own transcript store, so one `TranscriptSource` per agent
 * normalizes them into a single `SessionDigest`. Nothing downstream (ranking,
 * re-ranking, the RPC, the UI) knows which agent a session came from — that is
 * what keeps the feature harness-agnostic rather than Claude-shaped.
 */

/** One past agent session, normalized across harnesses. */
export interface SessionDigest {
	/** The agent that wrote it — "claude" | "codex" | "opencode". */
	agentId: string;
	/** The harness's OWN session id, the handle its resume command takes. */
	sessionId: string;
	/** Absolute working directory the session ran in (a task's worktree). */
	cwd: string;
	/** Branch the harness recorded, when it records one. */
	branch: string | null;
	startedAt: number | null;
	endedAt: number | null;
	/** The user's own messages, in order, trimmed. The searchable substance. */
	prompts: string[];
	/** Where the transcript lives, for the cache key and for "reveal". */
	path: string;
	/** mtime of `path` when read — the cache invalidation key. */
	mtimeMs: number;
}

/**
 * A harness's transcript store. `digestsFor` takes the worktrees we care about
 * (search is scoped to sessions that belong to a task) so a source can use the
 * cheapest lookup its layout allows: Claude shards by cwd, Codex by date,
 * OpenCode keeps a SQLite table.
 */
export interface TranscriptSource {
	agentId: string;
	/** Digests for sessions whose cwd is one of `cwds`. Never throws: a missing
	 *  or unreadable store is simply an agent with no history to search.
	 *  Async because the engine shares a process with the window — a store this
	 *  size read synchronously freezes the app for the length of the read. */
	digestsFor(cwds: string[]): Promise<SessionDigest[]>;
}

/** A ranked match, before it is joined back to a task for the UI. */
export interface RankedSession {
	digest: SessionDigest;
	score: number;
	/** The prompt lines that matched, for the excerpt and the re-rank prompt. */
	excerpts: string[];
}
