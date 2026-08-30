import type { CleanupCandidate } from "@ateam/protocol";
import { GitPullRequest, MessageSquare, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
 */

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
		</span>
	);
}

export function CleanupDialog({
	projectId,
	confirm,
	reload,
	onClose,
}: {
	projectId: string;
	confirm: (title: string, body?: string) => Promise<boolean>;
	reload: () => void;
	onClose: () => void;
}) {
	const [items, setItems] = useState<CleanupCandidate[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [onlyRecommended, setOnlyRecommended] = useState(false);
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

	const shown = onlyRecommended ? items.filter((i) => i.recommended) : items;
	const recommendedCount = items.filter((i) => i.recommended).length;

	const dismiss = (id: string) => {
		setItems((prev) => {
			const next = prev.filter((i) => i.task.id !== id);
			setSelectedId((cur) => (cur === id ? (next[0]?.task.id ?? null) : cur));
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
	};

	const selected = shown.find((i) => i.task.id === selectedId) ?? null;

	return (
		<div className="overlay" onMouseDown={onClose}>
			<div className="cleanup" onMouseDown={(e) => e.stopPropagation()}>
				<div className="cleanup-head">
					<strong>Clean up worktrees</strong>
					<span className="muted" style={{ marginLeft: 8 }}>
						{items.length} worktree{items.length === 1 ? "" : "s"} · {recommendedCount} recommended
					</span>
					<span style={{ flex: 1 }} />
					<div className="cleanup-filter">
						<button
							type="button"
							className={onlyRecommended ? "" : "on"}
							onClick={() => setOnlyRecommended(false)}
						>
							All
						</button>
						<button
							type="button"
							className={onlyRecommended ? "on" : ""}
							onClick={() => setOnlyRecommended(true)}
							title="Only the ones the sweep would remove: merged, clean, no live session"
						>
							Recommended
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
								{onlyRecommended ? "Nothing recommended" : "Nothing to clean"}
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
										{it.task.name}
										{it.recommended && <span className="rec-dot" title={it.reason} />}
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
											{selected.recommended && <span className="rec-tag">recommended</span>}
										</div>
										<div className="branch muted">
											{selected.task.branch} · {selected.reason}
										</div>
										<div className="branch muted">{selected.task.triage.reason}</div>
									</div>
									<div style={{ display: "flex", gap: 6, flex: "none" }}>
										<button
											type="button"
											className="navbtn"
											onClick={() => dismiss(selected.task.id)}
											title="Keep this worktree and jump back into its terminal"
										>
											<MessageSquare size={14} strokeWidth={1.75} />
											Keep &amp; continue
										</button>
										<button
											type="button"
											className="navbtn danger"
											onClick={() => del(selected)}
											title="Delete this worktree and its branch"
										>
											<Trash2 size={14} strokeWidth={1.75} />
											Delete
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
