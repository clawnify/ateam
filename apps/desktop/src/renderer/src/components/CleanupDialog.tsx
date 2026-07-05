import { MessageSquare, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { CleanupCandidate } from "@ateam/protocol";
import { IconButton } from "./IconButton";
import { TerminalView } from "./Terminal";

/**
 * Interactive cleanup: a sidebar of worktrees advised for deletion + the live
 * terminal of the selected one. Per item you either Delete it (removes the
 * worktree) or Keep & continue (dismiss the advice and jump back into its
 * terminal). Both remove it from the list; the dialog stays open for the rest.
 */
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

	useEffect(() => {
		void window.ateam.tasks.cleanupCandidates(projectId).then((list) => {
			setItems(list);
			setSelectedId(list[0]?.id ?? null);
			setLoading(false);
		});
	}, [projectId]);

	const dismiss = (id: string) => {
		setItems((prev) => {
			const next = prev.filter((i) => i.id !== id);
			setSelectedId((cur) => (cur === id ? (next[0]?.id ?? null) : cur));
			if (next.length === 0) onClose();
			return next;
		});
	};

	const del = async (item: CleanupCandidate) => {
		try {
			await window.ateam.tasks.remove({ id: item.id, deleteBranch: true });
		} catch (e) {
			// git refuses to remove a dirty/unmerged worktree without --force.
			const msg = e instanceof Error ? e.message : String(e);
			if (/modified or untracked|not fully merged|use --force/i.test(msg)) {
				const ok = await confirm(
					"Force delete?",
					`"${item.name}" has uncommitted/untracked changes or an unmerged branch. Delete it anyway?`,
				);
				if (!ok) return;
				try {
					await window.ateam.tasks.remove({
						id: item.id,
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
		dismiss(item.id);
	};

	const selected = items.find((i) => i.id === selectedId) ?? null;

	return (
		<div className="overlay" onMouseDown={onClose}>
			<div className="cleanup" onMouseDown={(e) => e.stopPropagation()}>
				<div className="cleanup-head">
					<strong>Clean up worktrees</strong>
					<span className="muted" style={{ marginLeft: 8 }}>
						{items.length} to review
					</span>
					<span style={{ flex: 1 }} />
					<IconButton icon={X} label="Close" onClick={onClose} />
				</div>

				<div className="cleanup-body">
					<div className="cleanup-list">
						{loading ? (
							<div className="tree-empty">Scanning…</div>
						) : items.length === 0 ? (
							<div className="tree-empty">Nothing to clean</div>
						) : (
							items.map((it) => (
								<button
									type="button"
									key={it.id}
									className={`cleanup-item ${it.id === selectedId ? "selected" : ""}`}
									onClick={() => setSelectedId(it.id)}
								>
									<span className="tname">{it.name}</span>
									<span className="sub">
										{it.branch} · {it.reason}
									</span>
								</button>
							))
						)}
					</div>

					<div className="cleanup-main">
						{selected ? (
							<>
								<div className="cleanup-detail-head">
									<div style={{ minWidth: 0 }}>
										<div className="title">{selected.name}</div>
										<div className="branch muted">
											{selected.branch} · {selected.reason}
										</div>
									</div>
									<div style={{ display: "flex", gap: 6, flex: "none" }}>
										<button
											type="button"
											className="navbtn"
											onClick={() => dismiss(selected.id)}
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
									<div
										className="term"
										style={{ display: "grid", placeItems: "center" }}
									>
										<span className="muted">
											No live terminal — the agent session has ended.
										</span>
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
