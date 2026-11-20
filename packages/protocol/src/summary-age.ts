// Whether a task's summary still says where it stands. The engine writes one a
// few minutes after the agent goes quiet (server/task-summaries.ts), stamped
// with the activity it read, so anything since makes it a description of a
// moment that has passed: "one file with uncommitted changes" after the agent
// committed it. Every reader marks that the same way: the desktop says when it
// was written, the Lead and agents get STALE_SUMMARY_NOTE beside it.
// Imports nothing, so every client resolves it (desktop, phone, engine).

/** The fields it reads, on a TaskDTO or the engine's task row alike. */
interface Summarized {
	summary?: string | null;
	summaryAsOf?: number | null;
	lastEventAt?: number | null;
}

/**
 * When the summary was written, if the task has had activity since. Null when
 * it is current, or from an engine that doesn't say when it was written.
 */
export function staleSummaryAt(t: Summarized): number | null {
	const asOf = t.summaryAsOf;
	if (!t.summary || asOf == null || t.lastEventAt == null) return null;
	return t.lastEventAt > asOf ? asOf : null;
}

/** Told to the Lead and agents beside a summary written before the latest turn. */
export const STALE_SUMMARY_NOTE =
	"Written before the task's latest turn, so it may be out of date.";
