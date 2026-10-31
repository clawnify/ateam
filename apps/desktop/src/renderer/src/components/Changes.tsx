import type { DiffResultDTO } from "@ateam/protocol";
import { RotateCw } from "lucide-react";
import { IconButton } from "./IconButton";

/**
 * The +N -N button for a task's changes: everything its branch adds to its base,
 * committed or not. It opens the changes view and, once that is open, goes back
 * to the terminal. The task panel's actions bar and a Mission Control tile's bar.
 */
export function DiffStat({
	diff,
	open,
	onToggle,
}: {
	diff: DiffResultDTO | null;
	open: boolean;
	onToggle: () => void;
}) {
	const additions = diff?.files.reduce((n, f) => n + f.additions, 0) ?? 0;
	const deletions = diff?.files.reduce((n, f) => n + f.deletions, 0) ?? 0;
	return (
		<button
			type="button"
			className={`diffstat ${open ? "active" : ""}`}
			title={open ? "Back to terminal" : "Show changes"}
			onClick={onToggle}
		>
			<span className="add">+{additions}</span>
			<span className="del">-{deletions}</span>
		</button>
	);
}

/**
 * A task's changed files with their counts, under a "Changes" head that
 * refreshes them. Picking one is the caller's: the task panel shows its diff
 * beside the list, a Mission Control tile shows it in the list's place.
 */
export function ChangesList({
	diff,
	selected,
	onSelect,
	onRefresh,
}: {
	diff: DiffResultDTO | null;
	selected: string | null;
	onSelect: (path: string) => void;
	onRefresh: () => void;
}) {
	return (
		<div className="changes">
			<div className="changes-head">
				<strong>Changes</strong>
				<IconButton icon={RotateCw} label="Refresh changes" onClick={onRefresh} />
			</div>
			{diff?.files.length ? (
				diff.files.map((f) => (
					<button
						type="button"
						key={f.path}
						className={`file ${selected === f.path ? "selected" : ""}`}
						title={f.path}
						onClick={() => onSelect(f.path)}
					>
						<span className="fpath">{f.path}</span>
						<span className="fstat">
							<span className="add">+{f.additions}</span>{" "}
							<span className="del">-{f.deletions}</span>
						</span>
					</button>
				))
			) : (
				<div className="muted" style={{ padding: "4px 10px" }}>
					No changes
				</div>
			)}
		</div>
	);
}
