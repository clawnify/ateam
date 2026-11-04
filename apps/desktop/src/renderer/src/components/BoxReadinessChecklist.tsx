import { githubAccessProblem } from "@ateam/protocol";
import { useCallback, useEffect, useState } from "react";
import type { BoxReadiness } from "../../../shared/host";
import { setUpPhoneAccess } from "../lib/box-actions";
import { GithubAccess } from "./GithubAccess";

// The set-up-so-far checklist shown after a box is created OR prepared over SSH: what's
// already task-ready (the engine) vs the steps left. GitHub is connected right here,
// with a token pasted into Ateam rather than into the box's terminal (the clone needs
// it up front), and a coding agent installs from the agent picker if none is there.
// A box with no network port can join the tailnet from here too, for Ateam Go.
// Recheck re-probes; the git identity fills itself in from the GitHub account.
// Shared so every "add a box" flow ends the same way instead of on a cryptic clone error.
const IPC_PREFIX = /^Error invoking remote method '[^']+': (Error: )?/;

export function BoxReadinessChecklist({
	alias,
	label,
	agents,
	networkPort,
	title,
	onDone,
}: {
	/** The connected box to probe (ssh_config alias). */
	alias: string;
	/** How the box is named in sentences; the alias when unset. */
	label?: string;
	/** Agents already installed on the box (from the create/install handshake). */
	agents: string[];
	/** Where its network port listens, from the same handshake: null when it has none,
	 *  absent from an engine that doesn't say (no row then). */
	networkPort?: string | null;
	title: string;
	onDone: () => void;
}) {
	const [ready, setReady] = useState<BoxReadiness | null>(null);
	const [checking, setChecking] = useState(false);
	// Whether the box's GitHub access needs nothing more; null until it's been read.
	const [githubOk, setGithubOk] = useState<boolean | null>(null);
	// Bumped by Recheck, so the GitHub row reads the box again too.
	const [round, setRound] = useState(0);
	// The network port as the last handshake gave it, then as setting up phone access left it.
	const [port, setPort] = useState(networkPort);
	const [joining, setJoining] = useState<{ approval: string | null } | null>(null);
	const [joinError, setJoinError] = useState<string | null>(null);

	const joinTailnet = async () => {
		setJoining({ approval: null });
		setJoinError(null);
		try {
			const status = await setUpPhoneAccess(alias, (url) => setJoining({ approval: url }));
			setPort(status.info.wsAddr ?? null);
			setRound((r) => r + 1);
		} catch (e) {
			setJoinError((e instanceof Error ? e.message : String(e)).replace(IPC_PREFIX, ""));
		} finally {
			setJoining(null);
		}
	};

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
				<li className="done">Engine</li>
				{port === undefined ? null : port ? (
					<li className="done">Ateam Go reaches it at {port}</li>
				) : (
					<li className="todo">
						{joining ? (
							joining.approval ? (
								<>
									Approve it on the Tailscale page that opened in your browser (press Connect at the
									end), or open {joining.approval}
								</>
							) : (
								"Joining your tailnet…"
							)
						) : (
							<>
								Ateam Go can't reach it yet: joining your tailnet takes passwordless sudo here, and
								you approve the box on Tailscale.{" "}
								<button type="button" onClick={() => void joinTailnet()}>
									Set up phone access
								</button>
							</>
						)}
						{joinError ? <div className="gh-access-problem">{joinError}</div> : null}
					</li>
				)}
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
