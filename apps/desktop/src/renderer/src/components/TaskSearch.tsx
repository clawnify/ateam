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
 * The popover answers in two passes. Task names match instantly and locally;
 * the sessions that TALKED about it arrive a moment later from the engine's
 * transcript index. The last row is always the AI search, which is how you find
 * a session whose words you no longer remember. It stays visible even when
 * there are results, because "none of these is the one" is exactly when you
 * want it, and it is the only way to discover the feature exists.
 */

/**
 * A row in the popover: something to open, or the offer to ask the model. A row
 * carries what it shows plus what a click does, so nothing downstream has to
 * know whether it came from a task name or a transcript.
 */
type Row =
	| { kind: "result"; key: string; name: string; subtitle: string; meta: string; open: () => void }
	| { kind: "ai" };

const DEBOUNCE_MS = 200;
/** Task-name matches shown before session matches get their turn. */
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
	const [sessionHits, setSessionHits] = useState<SessionHitDTO[]>([]);
	const [aiHits, setAiHits] = useState<SessionHitDTO[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [dismissed, setDismissed] = useState(false);
	const [cursor, setCursor] = useState(0);
	const boxRef = useRef<HTMLDivElement>(null);
	// Only the newest search may write results: a slower earlier answer arriving
	// late would otherwise replace the one being read.
	const runId = useRef(0);

	const trimmed = query.trim();
	// A tag query is a filter, and the board is already showing its answer.
	const isFilter = trimmed.startsWith("#");
	const open = trimmed !== "" && !isFilter && !dismissed;

	const reset = useCallback(() => {
		runId.current++;
		setSessionHits([]);
		setAiHits(null);
		setBusy(false);
		setCursor(0);
	}, []);

	// Lexical pass: instant, free, and re-run as the query settles.
	useEffect(() => {
		setDismissed(false);
		reset();
		if (trimmed === "" || isFilter || projectIds.length === 0) return;
		const run = ++runId.current;
		const timer = setTimeout(async () => {
			const lists = await Promise.all(
				projectIds.map((projectId) =>
					window.ateam.search.sessions({ projectId, query: trimmed }).catch(() => []),
				),
			);
			if (run === runId.current) setSessionHits(interleave(lists));
		}, DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [trimmed, isFilter, projectIds, reset]);

	const askAi = useCallback(async () => {
		if (!trimmed || projectIds.length === 0 || busy) return;
		const run = ++runId.current;
		setBusy(true);
		try {
			const lists = await Promise.all(
				projectIds.map((projectId) =>
					window.ateam.search.sessions({ projectId, query: trimmed, ai: true }).catch(() => []),
				),
			);
			if (run !== runId.current) return;
			setAiHits(interleave(lists));
			setCursor(0);
		} finally {
			if (run === runId.current) setBusy(false);
		}
	}, [trimmed, projectIds, busy]);

	const rows = useMemo<Row[]>(() => {
		if (!open) return [];
		if (aiHits) return aiHits.map((hit) => sessionRow(hit, onOpenSession));
		const needle = trimmed.toLowerCase();
		const named = new Set<string>();
		const out: Row[] = [];
		for (const task of tasks) {
			if (named.size >= MAX_TASK_ROWS) break;
			const matched =
				task.name.toLowerCase().includes(needle) ||
				task.branch.toLowerCase().includes(needle) ||
				(task.description?.toLowerCase().includes(needle) ?? false);
			if (!matched) continue;
			named.add(task.id);
			out.push({
				kind: "result",
				key: task.id,
				name: task.name,
				subtitle: task.branch,
				meta: "",
				open: () => onOpenTask(task),
			});
		}
		// A session match for a task already listed by name adds nothing but a
		// duplicate row; the name match is the stronger signal, so it stands.
		for (const hit of sessionHits) {
			if (!named.has(hit.taskId)) out.push(sessionRow(hit, onOpenSession));
		}
		out.push({ kind: "ai" });
		return out;
	}, [open, aiHits, trimmed, tasks, sessionHits, onOpenTask, onOpenSession]);

	useEffect(() => {
		if (cursor >= rows.length) setCursor(0);
	}, [rows.length, cursor]);

	useEffect(() => {
		if (!open) return;
		const onClick = (e: MouseEvent) => {
			if (!boxRef.current?.contains(e.target as Node)) setDismissed(true);
		};
		document.addEventListener("mousedown", onClick);
		return () => document.removeEventListener("mousedown", onClick);
	}, [open]);

	const activate = (row: Row) => {
		if (row.kind === "ai") return void askAi();
		row.open();
		setDismissed(true);
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Escape" && open) {
			e.preventDefault();
			setDismissed(true);
		} else if (e.key === "Enter") {
			e.preventDefault();
			const row = rows[cursor];
			if (row) activate(row);
		} else if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
			e.preventDefault();
			const step = e.key === "ArrowDown" ? 1 : -1;
			setCursor((c) => Math.max(0, Math.min(rows.length - 1, c + step)));
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
				onFocus={() => setDismissed(false)}
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
								onMouseEnter={() => setCursor(i)}
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
								onMouseEnter={() => setCursor(i)}
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
