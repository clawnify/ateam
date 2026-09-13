import type { GithubIssueDTO } from "@ateam/protocol";
import { CircleDot, ExternalLink, Play, X } from "lucide-react";
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
