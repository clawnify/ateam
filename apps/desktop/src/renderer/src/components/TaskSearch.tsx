import type { SessionHitDTO } from "@ateam/protocol";
import { Search, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The topbar search box. Typing filters the board and sidebar instantly, as it
 * always has; the sparkle answers a different question — "which session was I
 * working on X?" — by describing the work instead of naming the task.
 *
 * That question used to mean opening a fresh agent session just to ask it. The
 * engine does the finding (see @ateam/server session-search); this component
 * owns the two states that only exist on screen: whether an AI search is in
 * flight, and whether its results are showing.
 */
export function TaskSearch({
	query,
	onQuery,
	projectIds,
	onOpen,
}: {
	query: string;
	onQuery: (q: string) => void;
	/** Every project on the active card — a repo open on the Mac AND on a box is
	 *  two engines, each holding its own half of the history. */
	projectIds: string[];
	onOpen: (hit: SessionHitDTO) => void;
}) {
	const [hits, setHits] = useState<SessionHitDTO[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [cursor, setCursor] = useState(0);
	const boxRef = useRef<HTMLDivElement>(null);
	// Only the newest search may write results: an earlier, slower answer
	// arriving late would otherwise replace the one the user is reading.
	const runId = useRef(0);

	const close = useCallback(() => {
		setHits(null);
		setBusy(false);
		runId.current++;
	}, []);

	const search = useCallback(async () => {
		const q = query.trim();
		if (!q || projectIds.length === 0 || busy) return;
		const run = ++runId.current;
		setBusy(true);
		setHits(null);
		setCursor(0);
		try {
			const lists = await Promise.all(
				projectIds.map((projectId) =>
					window.ateam.search.sessions({ projectId, query: q, ai: true }).catch(() => []),
				),
			);
			if (run !== runId.current) return;
			setHits(interleave(lists));
		} finally {
			if (run === runId.current) setBusy(false);
		}
	}, [query, projectIds, busy]);

	// Results answer the question that was asked; once the question changes they
	// are stale, and a stale answer under a new query reads as a wrong one.
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the query alone.
	useEffect(() => close(), [query]);

	useEffect(() => {
		if (!hits && !busy) return;
		const onClick = (e: MouseEvent) => {
			if (!boxRef.current?.contains(e.target as Node)) close();
		};
		document.addEventListener("mousedown", onClick);
		return () => document.removeEventListener("mousedown", onClick);
	}, [hits, busy, close]);

	const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			e.preventDefault();
			const chosen = hits?.[cursor];
			if (chosen) onOpen(chosen);
			else void search();
		} else if (e.key === "Escape" && (hits || busy)) {
			e.preventDefault();
			close();
		} else if (hits && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
			e.preventDefault();
			const step = e.key === "ArrowDown" ? 1 : -1;
			setCursor((c) => Math.max(0, Math.min(hits.length - 1, c + step)));
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
			<button
				type="button"
				className={`ts-clear ts-ai ${busy ? "busy" : ""}`}
				title="Find the session where you did this"
				aria-label="Find the session where you did this"
				disabled={!query.trim() || projectIds.length === 0}
				onClick={() => void search()}
			>
				<Sparkles size={13} strokeWidth={1.75} />
			</button>

			{(busy || hits) && (
				<div className="ts-results" role="listbox" aria-label="Matching sessions">
					{busy && <div className="ts-note">Reading your past sessions…</div>}
					{hits?.length === 0 && (
						<div className="ts-note">No session matched that description.</div>
					)}
					{hits?.map((hit, i) => (
						<button
							type="button"
							key={`${hit.taskId}:${hit.sessionId}`}
							className={`ts-hit ${i === cursor ? "on" : ""}`}
							role="option"
							aria-selected={i === cursor}
							onMouseEnter={() => setCursor(i)}
							onClick={() => onOpen(hit)}
						>
							<span className="ts-hit-name">{hit.taskName}</span>
							<span className="ts-hit-why">{hit.why || hit.excerpt}</span>
							<span className="ts-hit-meta">
								{hit.agentId}
								{hit.branch ? ` · ${hit.branch}` : ""}
								{hit.endedAt ? ` · ${new Date(hit.endedAt).toLocaleDateString()}` : ""}
								{hit.terminalId ? " · session still open" : ""}
							</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
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
