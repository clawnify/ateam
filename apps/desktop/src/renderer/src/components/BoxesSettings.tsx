import {
	type ConnectionDTO,
	type GithubAccessDTO,
	PROTOCOL_VERSION,
	relativeAge,
} from "@ateam/protocol";
import { useCallback, useEffect, useState } from "react";
import type { HostStatus } from "../../../shared/host";
import { type BoxRow, boxesNeedingYou, boxRows, engineLabel } from "../boxes-settings";
import { GithubAccess } from "./GithubAccess";
import { Button } from "./ui/button";
import { usePrompt } from "./usePrompt";

// Settings → Boxes: every box this Mac has used, one card each, with what is
// known about it, its engine version and an Update when it's behind, and its
// GitHub access. Listing reads only what the desktop already holds, so opening
// the page never wakes a sleeping box: connecting one is a click, and so is
// everything that changes a box.

const IPC_PREFIX = /^Error invoking remote method '[^']+': (Error: )?/;
const errorText = (e: unknown) =>
	(e instanceof Error ? e.message : String(e)).replace(IPC_PREFIX, "");

function statusLine(row: BoxRow, now: number): string {
	if (row.state === "connected") return "Connected";
	if (row.state === "asleep") return "Asleep";
	if (row.failure) return `Couldn't connect: ${row.failure}`;
	const age = relativeAge(row.lastSeen, now);
	return age
		? `Not connected, last seen ${age === "just now" ? age : `${age} ago`}`
		: "Not connected";
}

export function BoxesSettings() {
	const [connections, setConnections] = useState<ConnectionDTO[] | null>(null);
	const [held, setHeld] = useState<HostStatus[]>([]);
	const [failures, setFailures] = useState<Record<string, string>>({});
	const [canUpdateSsh, setCanUpdateSsh] = useState(false);
	const [appRelease, setAppRelease] = useState("");
	const [github, setGithub] = useState<Record<string, GithubAccessDTO>>({});
	// alias → what's running on it right now ("Connecting…"), and the last outcome.
	const [busy, setBusy] = useState<Record<string, string>>({});
	const [notes, setNotes] = useState<Record<string, { text: string; error: boolean }>>({});
	const { ui: promptUi, confirm } = usePrompt();

	const load = useCallback(async () => {
		const [list, connected, failed, updatable, release, githubByBox] = await Promise.all([
			window.ateamHost.list(),
			window.ateamHost.connected(),
			window.ateamHost.failures(),
			window.ateamHost.canUpdateBoxes(),
			window.ateamHost.appRelease(),
			window.ateamHost.boxGithub(),
		]);
		setConnections(list);
		setHeld(connected);
		setFailures(failed);
		setCanUpdateSsh(updatable);
		setAppRelease(release);
		setGithub(githubByBox);
	}, []);

	useEffect(() => {
		void load();
		return window.ateamHost.onConnectionsChanged(() => void load());
	}, [load]);

	const act = async (alias: string, label: string, work: () => Promise<string | null>) => {
		setBusy((b) => ({ ...b, [alias]: label }));
		setNotes(({ [alias]: _, ...rest }) => rest);
		try {
			const text = await work();
			if (text) setNotes((n) => ({ ...n, [alias]: { text, error: false } }));
		} catch (e) {
			setNotes((n) => ({ ...n, [alias]: { text: errorText(e), error: true } }));
		} finally {
			setBusy(({ [alias]: _, ...rest }) => rest);
			void load();
		}
	};

	const connect = (row: BoxRow) =>
		act(row.alias, row.state === "asleep" ? "Waking…" : "Connecting…", async () => {
			await window.ateamHost.connect(row.alias, { wake: true });
			return null;
		});

	const update = async (row: BoxRow) => {
		const ok = await confirm(
			`Update ${row.title}?`,
			"Ateam reinstalls its engine at the current release, which restarts it, so agents running there can stop.",
		);
		if (!ok) return;
		await act(row.alias, "Updating…", async () => {
			const r = await window.ateamHost.updateBox(row.alias);
			if (r.via === "ssh") return "Updated.";
			return r.started
				? "Update started. The box reconnects by itself in a minute or two."
				: "An update is already running there.";
		});
	};

	const forget = async (row: BoxRow) => {
		const ok = await confirm(
			`Remove ${row.title} from this list?`,
			"The box and everything on it stay as they are. Ateam stops showing it until you connect to it again.",
		);
		if (!ok) return;
		await act(row.alias, "Removing…", async () => {
			await window.ateamHost.forget(row.alias);
			return null;
		});
	};

	if (connections === null) return <div className="gh-access-muted">Loading boxes…</div>;
	const rows = boxRows(connections, held, failures, {
		protocol: PROTOCOL_VERSION,
		release: appRelease,
	});
	if (rows.length === 0) {
		return (
			<div className="gh-access-muted">
				No boxes yet. Add one from New task → Run on → Add a remote connection.
			</div>
		);
	}
	const now = Date.now();
	const needing = boxesNeedingYou(rows, github, now);

	return (
		<div className="boxes-settings">
			{promptUi}
			{rows.map((row) => {
				const note = notes[row.alias];
				const canUpdate =
					row.state === "connected" &&
					row.engine === "behind" &&
					(row.transport === "ws" || canUpdateSsh);
				return (
					<section key={row.alias} className="box-card" aria-label={row.title}>
						<div className="box-card-head">
							<div className="box-card-text">
								<div className="box-card-title">
									{row.title}
									{needing.has(row.alias) ? (
										<span className="box-card-dot" role="img" aria-label="needs you" />
									) : null}
								</div>
								<div className="box-card-detail">{row.detail}</div>
								<div className="box-card-status">
									<span className={`box-card-state ${row.state}`}>{statusLine(row, now)}</span>
									{" · "}
									<span className={row.engine === "behind" ? "box-card-behind" : undefined}>
										{engineLabel(row)}
									</span>
								</div>
							</div>
							<div className="box-card-actions">
								{busy[row.alias] ? (
									<span className="gh-access-muted">{busy[row.alias]}</span>
								) : (
									<>
										{row.state !== "connected" ? (
											<Button size="xs" variant="outline" onClick={() => void connect(row)}>
												Connect
											</Button>
										) : null}
										{canUpdate ? (
											<Button size="xs" variant="outline" onClick={() => void update(row)}>
												Update
											</Button>
										) : null}
										<Button size="xs" variant="ghost" onClick={() => void forget(row)}>
											Forget
										</Button>
									</>
								)}
							</div>
						</div>
						{note ? (
							<div className={note.error ? "gh-access-problem" : "gh-access-muted"}>
								{note.text}
							</div>
						) : null}
						<div className="box-card-section">
							<div className="box-card-label">GitHub</div>
							{row.state !== "connected" ? (
								<div className="gh-access-muted">
									Connect to see which GitHub account and token it uses.
								</div>
							) : !row.githubReady ? (
								<div className="gh-access-muted">
									Update the box to manage its GitHub access from here.
								</div>
							) : (
								<GithubAccess alias={row.alias} label={row.title} />
							)}
						</div>
					</section>
				);
			})}
		</div>
	);
}
