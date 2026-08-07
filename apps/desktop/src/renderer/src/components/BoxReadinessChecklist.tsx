import { useCallback, useEffect, useState } from "react";
import type { BoxReadiness } from "../../../shared/host";

// The set-up-so-far checklist shown after a box is created OR prepared over SSH: what's
// already task-ready (engine + Tailscale) vs the interactive steps left — GitHub sign-in
// (the clone needs it up front) and, if none is installed, a coding agent. Recheck
// re-probes; the git identity auto-derives once the box is signed into GitHub. Shared so
// every "add a box" flow ends the same way instead of on a cryptic clone error.
export function BoxReadinessChecklist({
	alias,
	agents,
	title,
	onDone,
}: {
	/** The connected box to probe (ssh_config alias). */
	alias: string;
	/** Agents already installed on the box (from the create/install handshake). */
	agents: string[];
	title: string;
	onDone: () => void;
}) {
	const [ready, setReady] = useState<BoxReadiness | null>(null);
	const [checking, setChecking] = useState(false);

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
				<li className={ready?.gh.signedIn ? "done" : "todo"}>
					{ready?.gh.signedIn
						? `GitHub signed in${ready.gh.login ? ` as ${ready.gh.login}` : ""}`
						: "GitHub — sign in: "}
					{!ready?.gh.signedIn ? <code>gh auth login</code> : null}
				</li>
				<li className={ready?.gitName ? "done" : "todo"}>
					{ready?.gitName
						? `git identity (${ready.gitName})`
						: "git identity — sets automatically after GitHub sign-in"}
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
				<button type="button" disabled={checking} onClick={() => void check()}>
					{checking ? "Checking…" : "Recheck"}
				</button>
				<button type="button" className="primary" onClick={onDone}>
					Done
				</button>
			</div>
		</div>
	);
}
