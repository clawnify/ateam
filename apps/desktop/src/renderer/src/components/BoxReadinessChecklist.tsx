import { githubAccessProblem } from "@ateam/protocol";
import { useCallback, useEffect, useState } from "react";
import type { BoxReadiness } from "../../../shared/host";
import { GithubAccess } from "./GithubAccess";

// The set-up-so-far checklist shown after a box is created OR prepared over SSH: what's
// already task-ready (engine + Tailscale) vs the steps left. GitHub is connected right
// here, with a token pasted into Ateam rather than into the box's terminal (the clone
// needs it up front), and a coding agent installs from the agent picker if none is
// there. Recheck re-probes; the git identity fills itself in from the GitHub account.
// Shared so every "add a box" flow ends the same way instead of on a cryptic clone error.
export function BoxReadinessChecklist({
	alias,
	label,
	agents,
	title,
	onDone,
}: {
	/** The connected box to probe (ssh_config alias). */
	alias: string;
	/** How the box is named in sentences; the alias when unset. */
	label?: string;
	/** Agents already installed on the box (from the create/install handshake). */
	agents: string[];
	title: string;
	onDone: () => void;
}) {
	const [ready, setReady] = useState<BoxReadiness | null>(null);
	const [checking, setChecking] = useState(false);
	// Whether the box's GitHub access needs nothing more; null until it's been read.
	const [githubOk, setGithubOk] = useState<boolean | null>(null);
	// Bumped by Recheck, so the GitHub row reads the box again too.
	const [round, setRound] = useState(0);

	const check = useCallback(async () => {
		setChecking(true);
		try {
			setReady(await window.ateamHost.boxReadiness(alias));
		} catch {
			// A probe failure just leaves the checklist partial — not worth blocking on.
		} finally {
			setChecking(false);
		}
	}, [alias]);
	// Probe once when the box appears (and again if it changes).
	useEffect(() => {
		void check();
	}, [check]);

	return (
		<div className="box-ready">
			<div className="box-ready-title">{title}</div>
			<ul className="box-ready-list">
				<li className="done">Engine + Tailscale</li>
				<li className={(githubOk ?? ready?.gh.signedIn) ? "done" : "todo"}>
					<GithubAccess
						key={round}
						alias={alias}
						label={label ?? alias}
						onAccess={(access, connected) => {
							setGithubOk(githubAccessProblem(access) === null);
							// Connecting derives the git identity on the box: show it.
							if (connected) void check();
						}}
					/>
				</li>
				<li className={ready?.gitName ? "done" : "todo"}>
					{ready?.gitName
						? `git identity (${ready.gitName})`
						: "git identity: sets itself from your GitHub account once GitHub is connected"}
				</li>
				{agents.length === 0 ? (
					<li className="todo">no coding agent yet — install one from the agent picker</li>
				) : (
					agents.map((a) => (
						<li key={a} className="done">
							{a} installed
						</li>
					))
				)}
			</ul>
			<div className="box-ready-actions">
				<button
					type="button"
					disabled={checking}
					onClick={() => {
						setRound((r) => r + 1);
						void check();
					}}
				>
					{checking ? "Checking…" : "Recheck"}
				</button>
				<button type="button" className="primary" onClick={onDone}>
					Done
				</button>
			</div>
		</div>
	);
}
