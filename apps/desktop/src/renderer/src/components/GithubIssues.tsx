import type { GithubIssueDTO } from "@ateam/protocol";
import { CircleDot, ExternalLink, Play, X } from "lucide-react";
import { useState } from "react";
import { IconButton } from "./IconButton";
import "./github-issues.css";

export function GithubIssueCard({
	issue,
	selected,
	onSelect,
}: {
	issue: GithubIssueDTO;
	selected: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			className={`card issue-card ${selected ? "selected" : ""}`}
			onClick={(event) => {
				event.stopPropagation();
				onSelect();
			}}
		>
			<div className="issue-source">
				<CircleDot size={13} />
				<span>#{issue.number}</span>
			</div>
			<div className="name">{issue.title}</div>
			<div className="issue-labels">
				{issue.labels.map((label) => (
					<span className="tag" key={label}>
						{label}
					</span>
				))}
			</div>
			<div className="meta">GitHub issue</div>
		</button>
	);
}

export function GithubIssuePanel({
	issue,
	onClose,
	onStart,
}: {
	issue: GithubIssueDTO;
	onClose: () => void;
	onStart: () => void;
}) {
	return (
		<aside className="panel issue-panel" aria-label={`Issue #${issue.number} details`}>
			<div className="actions">
				<CircleDot size={14} />
				<span className="spacer">
					{new URL(issue.url).pathname.split("/").slice(1, 3).join("/")} · #{issue.number}
				</span>
				<IconButton icon={X} label="Close issue" onClick={onClose} />
			</div>
			<div className="issue-description">
				<div className="issue-source">
					<CircleDot size={14} />
					Open
				</div>
				<h2>{issue.title}</h2>
				<div className="issue-byline">Opened by {issue.author}</div>
				<div className="issue-labels">
					{issue.labels.map((label) => (
						<span className="tag" key={label}>
							{label}
						</span>
					))}
				</div>
				<a className="navbtn" href={issue.url} target="_blank" rel="noreferrer">
					Open in GitHub <ExternalLink size={12} />
				</a>
				<div className="issue-body">{issue.body || "No description provided."}</div>
			</div>
			<div className="issue-start">
				<p>Start a task with this issue’s title and description.</p>
				<button type="button" className="primary" onClick={onStart}>
					<Play size={13} /> Start task…
				</button>
			</div>
		</aside>
	);
}

export function NewIssueDialog({
	repository,
	onClose,
	onCreated,
}: {
	repository: string;
	onClose: () => void;
	onCreated: (issue: GithubIssueDTO) => void;
}) {
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const submit = async () => {
		if (!title.trim() || busy) return;
		setBusy(true);
		setError(null);
		try {
			onCreated(await window.ateam.projects.createIssue(repository, { title, body }));
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			setError(
				/Unknown method/.test(message)
					? "Update Ateam to create GitHub issues."
					: message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""),
			);
			setBusy(false);
		}
	};
	return (
		<div className="overlay" onMouseDown={() => !busy && onClose()}>
			<form
				className="dialog composer new-issue"
				aria-label={`New issue in ${repository}`}
				onMouseDown={(e) => e.stopPropagation()}
				onKeyDown={(e) => {
					if (e.key === "Escape" && !busy) onClose();
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						void submit();
					}
				}}
				onSubmit={(e) => {
					e.preventDefault();
					void submit();
				}}
			>
				<div className="new-issue-repo">
					<CircleDot size={13} /> New issue in {repository}
				</div>
				<input
					// biome-ignore lint/a11y/noAutofocus: modal input should focus
					autoFocus
					className="comp-name"
					placeholder="Title"
					aria-label="Issue title"
					value={title}
					disabled={busy}
					onChange={(e) => setTitle(e.target.value)}
				/>
				<textarea
					className="comp-prompt"
					placeholder="Description (Markdown)"
					aria-label="Issue description"
					value={body}
					disabled={busy}
					onChange={(e) => setBody(e.target.value)}
				/>
				{error && (
					<div className="new-issue-error" role="alert">
						{error}
					</div>
				)}
				<div className="drow">
					<button type="button" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="submit" className="primary" disabled={!title.trim() || busy}>
						{busy ? "Creating…" : "Create issue"}
					</button>
				</div>
			</form>
		</div>
	);
}
