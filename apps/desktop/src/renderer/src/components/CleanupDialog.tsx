import type { CleanupCandidate } from "@ateam/protocol";
import { Archive, ArchiveRestore, GitPullRequest, MessageSquare, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { landingAfter } from "../cleanup-select";
import { relativeAge } from "../triage-order";
import { IconButton } from "./IconButton";
import { TerminalView } from "./Terminal";

/**
 * Interactive cleanup: a sidebar of worktrees + the live terminal of the
 * selected one. Per item you either Delete it (removes the worktree) or Keep &
 * continue (dismiss it and jump back into its terminal). Both remove it from
 * the list; the dialog stays open for the rest.
 *
 * The list is deliberately NOT pre-filtered. The old rule (merged + idle +
 * clean) decided for you and hid everything else; it now rides along as
 * `recommended` — advice, sorted to the top — because whether a worktree is
 * worth keeping turns on things only you weigh: how long since it moved,
 * whether its PR landed, whether the dirt left behind matters. Every deciding
 * factor is on the row, and "Recommended" narrows the list to the sweep's own
 * picks when you just want the safe ones gone.
 *
 * Archived tasks are here too, under their own filter: archiving is the other
 * answer to a stale task (off the board, worktree kept), so both live in one
 * place. A task on the board can be archived from here, and an archived one
 * brought back.
 *
 * A row that leaves the list hands the selection to the row below it, so a run
 * of deletes is one click each. "Delete N recommended" takes all of the sweep's
 * picks in one go.
 */

type Filter = "all" | "recommended" | "archived";

/** Sweep's picks first, then stalest first — the longest-ignored surfaces. */
function byCleanupOrder(a: CleanupCandidate, b: CleanupCandidate): number {
	if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
	return (a.task.lastEventAt ?? 0) - (b.task.lastEventAt ?? 0);
}

/** The factors the decision turns on, as one compact line. */
function Factors({ item, now }: { item: CleanupCandidate; now: number }) {
	const t = item.task;
	const age = relativeAge(t.lastEventAt, now);
	return (
		<span className="cleanup-factors">
			{age && <span>{age} ago</span>}
			{t.prNumber ? (
				<span className={`pr ${t.prState ?? ""}`}>
					<GitPullRequest size={11} strokeWidth={2} />#{t.prNumber} {t.prState ?? ""}
				</span>
			) : (
				<span className="muted">no PR</span>
			)}
			{t.gitStatus && (t.gitStatus.ahead > 0 || t.gitStatus.dirty > 0) && (
				<span>
					{t.gitStatus.ahead > 0 && `↑${t.gitStatus.ahead}`}
					{t.gitStatus.ahead > 0 && t.gitStatus.dirty > 0 && " · "}
					{t.gitStatus.dirty > 0 && `${t.gitStatus.dirty} changed`}
				</span>
			)}
			{item.terminalId && <span>live session</span>}
			{t.archivedAt != null && <span>archived</span>}
		</span>
	);
}

export function CleanupDialog({
	projectId,
	initialFilter = "all",
	confirm,
	reload,
	onClose,
}: {
	projectId: string;
	initialFilter?: Filter;
	confirm: (title: string, body?: string) => Promise<boolean>;
	reload: () => void;
	onClose: () => void;
}) {
	const [items, setItems] = useState<CleanupCandidate[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [filter, setFilter] = useState<Filter>(initialFilter);
	// A delete in flight: every action waits for it, so a quick second click
	// can't land on a row you haven't looked at yet.
	const [busy, setBusy] = useState<"one" | "all" | null>(null);
	// One clock for every age label, so the rows can't disagree with each other.
	const now = useMemo(() => Date.now(), []);

	useEffect(() => {
		void window.ateam.tasks.cleanupCandidates(projectId).then((list) => {
			const sorted = [...list].sort(byCleanupOrder);
			setItems(sorted);
			setSelectedId(sorted[0]?.task.id ?? null);
			setLoading(false);
		});
	}, [projectId]);

	const shown = items.filter((i) =>
		filter === "recommended"
			? i.recommended
			: filter === "archived"
				? i.task.archivedAt != null
				: true,
	);
	const recommendedCount = items.filter((i) => i.recommended).length;
	const archivedCount = items.filter((i) => i.task.archivedAt != null).length;
	// The list as shown NOW: a delete awaits git, so the render that started it
	// is stale by the time it lands.
	const shownRef = useRef(shown);
	shownRef.current = shown;

	/** Move a selection on `id` to the next row down, skipping `leaving` too. */
	const advanceFrom = (id: string, leaving: ReadonlySet<string> = new Set([id])) => {
		const to = landingAfter(
			shownRef.current.map((i) => i.task.id),
			id,
			leaving,
		);
		setSelectedId((cur) => (cur === id ? to : cur));
	};

	// Archive or bring back in place: the row stays, so the decision can go on.
	const setArchived = async (item: CleanupCandidate, archived: boolean) => {
		let task: CleanupCandidate["task"];
		try {
			task = await window.ateam.tasks.setArchived(item.task.id, archived);
		} catch (e) {
			console.error("[cleanup] archive failed", e);
			return;
		}
		// Brought back under "Archived", the row stays but leaves this view.
		if (!archived && filter === "archived") advanceFrom(task.id);
		setItems((prev) => prev.map((i) => (i.task.id === task.id ? { ...i, task } : i)));
	};

	const dismiss = (id: string, leaving?: ReadonlySet<string>) => {
		advanceFrom(id, leaving);
		setItems((prev) => {
			const next = prev.filter((i) => i.task.id !== id);
			if (next.length === 0) onClose();
			return next;
		});
	};

	const del = async (item: CleanupCandidate) => {
		// Nothing is pre-filtered any more, so a delete can land on unmerged or
		// dirty work. Ask before that one, on the facts, rather than hiding it.
		if (!item.recommended) {
			const ok = await confirm(
				`Delete "${item.task.name}"?`,
				`This worktree is not recommended for cleanup (${item.reason}). Its branch and any work in it go away.`,
			);
			if (!ok) return;
		}
		setBusy("one");
		try {
			try {
				await window.ateam.tasks.remove({ id: item.task.id, deleteBranch: true });
			} catch (e) {
				// git refuses to remove a dirty/unmerged worktree without --force.
				const msg = e instanceof Error ? e.message : String(e);
				if (/modified or untracked|not fully merged|use --force/i.test(msg)) {
					const ok = await confirm(
						"Force delete?",
						`"${item.task.name}" has uncommitted/untracked changes or an unmerged branch. Delete it anyway?`,
					);
					if (!ok) return;
					try {
						await window.ateam.tasks.remove({
							id: item.task.id,
							deleteBranch: true,
							force: true,
						});
					} catch (e2) {
						console.error("[cleanup] force delete failed", e2);
						return;
					}
				} else {
					console.error("[cleanup] delete failed", e);
					return;
				}
			}
			reload();
			dismiss(item.task.id);
		} finally {
			setBusy(null);
		}
	};

	// Every recommended row in one go. Not the server's sweep (tasks.cleanup):
	// that takes whatever is recommended project-wide, including a row you just
	// chose to keep. This takes the rows you were shown, after a fresh scan
	// drops any that went live or dirty while the dialog sat open, because
	// `remove` kills a live session.
	const deleteRecommended = async () => {
		const picks = items.filter((i) => i.recommended).map((i) => i.task.id);
		const ok = await confirm(
			`Delete ${picks.length} recommended worktree${picks.length === 1 ? "" : "s"}?`,
			"Each is merged, clean and has no live session. Its worktree and branch go away.",
		);
		if (!ok) return;
		setBusy("all");
		try {
			const fresh = new Map(
				(await window.ateam.tasks.cleanupCandidates(projectId)).map((c) => [c.task.id, c]),
			);
			// Rows show the fresh verdict, so one that dropped out says why.
			setItems((prev) => prev.map((i) => fresh.get(i.task.id) ?? i));
			const ids = picks.filter((id) => fresh.get(id)?.recommended);
			const leaving = new Set(ids);
			// One at a time, so each row leaves the list as it goes.
			for (const id of ids) {
				try {
					await window.ateam.tasks.remove({ id, deleteBranch: true });
				} catch (e) {
					console.error("[cleanup] delete failed", e);
					continue;
				}
				dismiss(id, leaving);
			}
			reload();
		} catch (e) {
			console.error("[cleanup] rescan failed", e);
		} finally {
			setBusy(null);
		}
	};

	const selected = shown.find((i) => i.task.id === selectedId) ?? null;

	return (
		<div className="overlay" onMouseDown={onClose}>
			<div className="cleanup" onMouseDown={(e) => e.stopPropagation()}>
				<div className="cleanup-head">
					<strong>Clean up worktrees</strong>
					<span className="muted" style={{ marginLeft: 8 }}>
						{items.length} worktree{items.length === 1 ? "" : "s"} · {recommendedCount} recommended
						{archivedCount > 0 && ` · ${archivedCount} archived`}
					</span>
					<span style={{ flex: 1 }} />
					{recommendedCount > 0 && (
						<button
							type="button"
							className="navbtn danger"
							style={{ marginRight: 8 }}
							disabled={busy !== null}
							onClick={() => void deleteRecommended()}
							title="Delete every recommended worktree and its branch"
						>
							<Trash2 size={14} strokeWidth={1.75} />
							{busy === "all" ? "Deleting…" : `Delete ${recommendedCount} recommended`}
						</button>
					)}
					<div className="cleanup-filter">
						<button
							type="button"
							className={filter === "all" ? "on" : ""}
							onClick={() => setFilter("all")}
						>
							All
						</button>
						<button
							type="button"
							className={filter === "recommended" ? "on" : ""}
							onClick={() => setFilter("recommended")}
							title="Only the ones the sweep would remove: merged, clean, no live session"
						>
							Recommended
						</button>
						<button
							type="button"
							className={filter === "archived" ? "on" : ""}
							onClick={() => setFilter("archived")}
							title="Taken off the board after a stretch with no activity, or by hand. Nothing in them was deleted."
						>
							Archived
						</button>
					</div>
					<IconButton icon={X} label="Close" onClick={onClose} />
				</div>

				<div className="cleanup-body">
					<div className="cleanup-list">
						{loading ? (
							<div className="tree-empty">Scanning…</div>
						) : shown.length === 0 ? (
							<div className="tree-empty">
								{filter === "recommended"
									? "Nothing recommended"
									: filter === "archived"
										? "Nothing archived"
										: "Nothing to clean"}
							</div>
						) : (
							shown.map((it) => (
								<button
									type="button"
									key={it.task.id}
									className={`cleanup-item ${it.task.id === selectedId ? "selected" : ""} ${
										it.recommended ? "recommended" : ""
									}`}
									onClick={() => setSelectedId(it.task.id)}
								>
									<span className="tname">
										<span className="tname-text">{it.task.name}</span>
										{it.recommended && (
											<span className="pill green" title={it.reason}>
												recommended
											</span>
										)}
									</span>
									<span className="sub">{it.task.branch}</span>
									<Factors item={it} now={now} />
								</button>
							))
						)}
					</div>

					<div className="cleanup-main">
						{selected ? (
							<>
								<div className="cleanup-detail-head">
									<div style={{ minWidth: 0 }}>
										<div className="title">
											{selected.task.name}
											{selected.recommended && <span className="pill green">recommended</span>}
											{selected.task.archivedAt != null && <span className="pill">archived</span>}
										</div>
										<div className="branch muted">
											{selected.task.branch} · {selected.reason}
										</div>
										<div className="branch muted">{selected.task.triage.reason}</div>
									</div>
									<div style={{ display: "flex", gap: 6, flex: "none" }}>
										{selected.task.archivedAt != null ? (
											<button
												type="button"
												className="navbtn"
												disabled={busy !== null}
												onClick={() => void setArchived(selected, false)}
												title="Put it back on the board"
											>
												<ArchiveRestore size={14} strokeWidth={1.75} />
												Unarchive
											</button>
										) : (
											<>
												<button
													type="button"
													className="navbtn"
													disabled={busy !== null}
													onClick={() => void setArchived(selected, true)}
													title="Take it off the board, keeping the worktree and its conversation"
												>
													<Archive size={14} strokeWidth={1.75} />
													Archive
												</button>
												<button
													type="button"
													className="navbtn"
													disabled={busy !== null}
													onClick={() => dismiss(selected.task.id)}
													title="Keep this worktree and jump back into its terminal"
												>
													<MessageSquare size={14} strokeWidth={1.75} />
													Keep &amp; continue
												</button>
											</>
										)}
										<button
											type="button"
											className="navbtn danger"
											disabled={busy !== null}
											onClick={() => del(selected)}
											title="Delete this worktree and its branch"
										>
											<Trash2 size={14} strokeWidth={1.75} />
											{busy === "one" ? "Deleting…" : "Delete"}
										</button>
									</div>
								</div>
								{selected.terminalId ? (
									<TerminalView terminalId={selected.terminalId} />
								) : (
									<div className="term" style={{ display: "grid", placeItems: "center" }}>
										<span className="muted">No live terminal — the agent session has ended.</span>
									</div>
								)}
							</>
						) : (
							<div className="empty">Nothing selected</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
