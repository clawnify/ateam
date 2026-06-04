import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { Diff, Hunk, parseDiff } from "react-diff-view";
import "react-diff-view/style/index.css";
import { IconButton } from "./IconButton";

/**
 * GitHub-Desktop-style diff for one file, rendered from the raw `git diff`
 * patch text. Split (two-column) view when there's room, unified when narrow.
 */
export function FileDiffView({
	taskId,
	file,
	split,
	onClose,
}: {
	taskId: string;
	file: string;
	split: boolean;
	onClose: () => void;
}) {
	const [text, setText] = useState<string | null>(null);

	useEffect(() => {
		let on = true;
		setText(null);
		void window.grove.git.fileDiff(taskId, file).then((t) => {
			if (on) setText(t);
		});
		return () => {
			on = false;
		};
	}, [taskId, file]);

	const files = text ? parseDiff(text) : [];

	return (
		<div className="filediff">
			<div className="filediff-head">
				<span className="fname" title={file}>
					{file}
				</span>
				<IconButton icon={X} label="Back to terminal" onClick={onClose} />
			</div>
			<div className="filediff-body">
				{text === null ? (
					<div className="muted" style={{ padding: 12 }}>
						Loading…
					</div>
				) : files.length === 0 ? (
					<div className="muted" style={{ padding: 12 }}>
						No textual diff (binary or untracked file)
					</div>
				) : (
					files.map((f) => (
						<Diff
							key={`${f.oldRevision}-${f.newRevision}`}
							viewType={split ? "split" : "unified"}
							diffType={f.type}
							hunks={f.hunks}
						>
							{(hunks) =>
								hunks.map((h) => <Hunk key={h.content} hunk={h} />)
							}
						</Diff>
					))
				)}
			</div>
		</div>
	);
}
