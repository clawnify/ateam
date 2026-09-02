import type { SessionHitDTO, TaskDTO } from "@ateam/protocol";
import { Search, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * The topbar search box and its results popover.
 *
 * One box, two jobs, split by a prefix so neither hides the other:
 *   `#tag …`  filters the board and sidebar (see matchesTagQuery in App).
 *   anything  searches, and answers in this popover — never by hiding cards.
 *
 * Typing matches the tasks ALREADY IN THIS WINDOW — name, branch, description —
 * and nothing else. It costs a pass over an array, so there is nothing to
 * debounce and nothing to cancel. Transcripts are deliberately not in that
 * path: reading a board's session history is hundreds of MB off disk, and
 * paying it per keystroke made the box the most expensive control in the app.
 *
 * The last row is always the AI search, and it is what reads the transcripts —
 * one deliberate click, for the session whose words you no longer remember. It
 * stays visible even when there are results, because "none of these is the one"
 * is exactly when you want it, and it is the only way to discover it exists.
 */

/**
 * A row in the popover: something to open, or the offer to ask the model. A row
 * carries what it shows plus what a click does, so nothing downstream has to
 * know whether it came from a task name or a transcript.
 */
type Row =
	| { kind: "result"; key: string; name: string; subtitle: string; meta: string; open: () => void }
	| { kind: "ai" };

/** Task matches shown above the AI row. */
const MAX_TASK_ROWS = 6;

export function TaskSearch({
	query,
	onQuery,
	projectIds,
	tasks,
	onOpenTask,
	onOpenSession,
}: {
	query: string;
	onQuery: (q: string) => void;
	/** Every project on the active card: a repo open here AND on a box is two
	 *  engines, each holding its own half of the history. */
	projectIds: string[];
	/** Tasks on the active board, for the instant local name match. */
	tasks: TaskDTO[];
	onOpenTask: (task: TaskDTO) => void;
	onOpenSession: (hit: SessionHitDTO) => void;
}) {
	// The answer, the request in flight, the dismissal and the highlighted row are
	// each stamped with the question they belong to, and read back only when that
	// stamp still matches. Nothing has to be reset when the question changes: a
	// stale stamp simply stops matching. The old version reset them from an
	// effect keyed on `projectIds`, which the parent rebuilds every render — a
	// fresh array re-ran the effect, the effect set state, the state re-rendered
	// the parent. Derived state cannot spin that way.
	const [answer, setAnswer] = useState<{ key: string; hits: SessionHitDTO[] } | null>(null);
	const [pending, setPending] = useState<string | null>(null);
	const [dismissed, setDismissed] = useState<string | null>(null);
	const [caret, setCaret] = useState<{ scope: string; index: number }>({ scope: "", index: 0 });
	const boxRef = useRef<HTMLDivElement>(null);
	// Only the newest ask may write results: a slower earlier answer arriving late
	// would otherwise replace the one being read.
	const latest = useRef(0);

	const trimmed = query.trim();
	// What the popover is currently answering. Compared by value, so the parent
	// handing us a new-but-equal `projectIds` array is not a new question.
	const key = `${projectIds.join("\u0000")}\u0000${trimmed}`;
	// A tag query is a filter, and the board is already showing its answer.
	const isFilter = trimmed.startsWith("#");
	const open = trimmed !== "" && !isFilter && dismissed !== key;
	const aiHits = answer?.key === key ? answer.hits : null;
	const busy = pending === key;

	const askAi = useCallback(async () => {
		if (!trimmed || projectIds.length === 0 || pending === key) return;
		const run = ++latest.current;
		setPending(key);
		try {
			const lists = await Promise.all(
				projectIds.map((projectId) =>
					window.ateam.search.sessions({ projectId, query: trimmed, ai: true }).catch(() => []),
				),
			);
			if (run === latest.current) setAnswer({ key, hits: interleave(lists) });
		} finally {
			if (run === latest.current) setPending(null);
		}
	}, [key, trimmed, projectIds, pending]);

	const rows = useMemo<Row[]>(() => {
		if (!open) return [];
		if (aiHits) return aiHits.map((hit) => sessionRow(hit, onOpenSession));
		const needle = trimmed.toLowerCase();
		const out: Row[] = [];
		for (const task of tasks) {
			if (out.length >= MAX_TASK_ROWS) break;
			const matched =
				task.name.toLowerCase().includes(needle) ||
				task.branch.toLowerCase().includes(needle) ||
				(task.description?.toLowerCase().includes(needle) ?? false);
			if (!matched) continue;
			out.push({
				kind: "result",
				key: task.id,
				name: task.name,
				subtitle: task.branch,
				meta: "",
				open: () => onOpenTask(task),
			});
		}
		out.push({ kind: "ai" });
		return out;
	}, [open, aiHits, trimmed, tasks, onOpenTask, onOpenSession]);

	// Highlight, scoped to the list it was chosen from: a new question, or the
	// AI's answer replacing the task matches, starts back at the top. Clamped
	// here rather than corrected by an effect, so it can never point off the end.
	const scope = aiHits ? `ai\u0000${key}` : key;
	const cursor = Math.min(caret.scope === scope ? caret.index : 0, Math.max(0, rows.length - 1));
	const moveCursor = (index: number) => setCaret({ scope, index });

	useEffect(() => {
		if (!open) return;
		const onClick = (e: MouseEvent) => {
			if (!boxRef.current?.contains(e.target as Node)) setDismissed(key);
		};
		document.addEventListener("mousedown", onClick);
		return () => document.removeEventListener("mousedown", onClick);
	}, [open, key]);

	const activate = (row: Row) => {
		if (row.kind === "ai") return void askAi();
		row.open();
		setDismissed(key);
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Escape" && open) {
			e.preventDefault();
			setDismissed(key);
		} else if (e.key === "Enter") {
			e.preventDefault();
			const row = rows[cursor];
			if (row) activate(row);
		} else if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
			e.preventDefault();
			const step = e.key === "ArrowDown" ? 1 : -1;
			moveCursor(Math.max(0, Math.min(rows.length - 1, cursor + step)));
		}
	};

	return (
		<div className="task-search" ref={boxRef}>
			<Search size={14} strokeWidth={1.75} />
			<input
				type="text"
				placeholder="Search tasks…"
				value={query}
				onChange={(e) => onQuery(e.target.value)}
				onKeyDown={onKeyDown}
				onFocus={() => setDismissed(null)}
				aria-label="Search tasks"
			/>
			{query && (
				<button
					type="button"
					className="ts-clear"
					aria-label="Clear search"
					onClick={() => onQuery("")}
				>
					<X size={13} strokeWidth={2} />
				</button>
			)}

			{open && (
				<div className="ts-results" role="listbox" aria-label="Search results">
					{rows.map((row, i) =>
						row.kind === "ai" ? (
							<button
								type="button"
								key="ai"
								className={`ts-hit ts-ai ${i === cursor ? "on" : ""} ${busy ? "busy" : ""}`}
								role="option"
								aria-selected={i === cursor}
								disabled={busy}
								onMouseEnter={() => moveCursor(i)}
								onClick={() => void askAi()}
							>
								<span className="ts-hit-name">
									<Sparkles size={13} strokeWidth={1.75} />
									{busy ? "Reading your past sessions…" : "Find the session that did this"}
								</span>
								{!busy && (
									<span className="ts-hit-meta">Searches what you said, not just names</span>
								)}
							</button>
						) : (
							<button
								type="button"
								key={row.key}
								className={`ts-hit ${i === cursor ? "on" : ""}`}
								role="option"
								aria-selected={i === cursor}
								onMouseEnter={() => moveCursor(i)}
								onClick={() => activate(row)}
							>
								<span className="ts-hit-name">{row.name}</span>
								<span className="ts-hit-why">{row.subtitle}</span>
								{row.meta && <span className="ts-hit-meta">{row.meta}</span>}
							</button>
						),
					)}
				</div>
			)}
		</div>
	);
}

/** A session hit, as a row. Opening it lands on the task AND the terminal that
 *  ran the session; the excerpt is why the row is here at all. */
function sessionRow(hit: SessionHitDTO, onOpen: (hit: SessionHitDTO) => void): Row {
	return {
		kind: "result",
		key: `${hit.taskId}:${hit.sessionId}`,
		name: hit.taskName,
		subtitle: hit.why || hit.excerpt,
		meta: [
			hit.agentId,
			hit.endedAt ? new Date(hit.endedAt).toLocaleDateString() : null,
			hit.terminalId ? "session still open" : null,
		]
			.filter(Boolean)
			.join(" · "),
		open: () => onOpen(hit),
	};
}

/**
 * Merge per-engine result lists without inventing a cross-engine score. Each
 * list is already ranked; taking them in turn keeps every engine's best answer
 * near the top instead of letting whichever engine answered first win.
 */
function interleave(lists: SessionHitDTO[][]): SessionHitDTO[] {
	const out: SessionHitDTO[] = [];
	for (let i = 0; out.length < 8; i++) {
		const before = out.length;
		for (const list of lists) {
			const hit = list[i];
			if (hit) out.push(hit);
		}
		if (out.length === before) break;
	}
	return out.slice(0, 8);
}
