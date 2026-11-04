import {
	type ConnectionDTO,
	type GithubAccessDTO,
	NEEDS_PAIRING,
	PROTOCOL_VERSION,
	relativeAge,
} from "@ateam/protocol";
import { useCallback, useEffect, useState } from "react";
import type { HostStatus } from "../../../shared/host";
import { type BoxRow, boxesNeedingYou, boxRows, engineLabel } from "../boxes-settings";
import { useLeadHome } from "../useLeadHome";
import { BoxAccess } from "./BoxAccess";
import { CrossBox } from "./CrossBox";
import { GithubAccess } from "./GithubAccess";
import { Button } from "./ui/button";
import { usePrompt } from "./usePrompt";

// Settings → Boxes: every box this Mac has used, one card each, with what is
// known about it, its engine version and an Update when it's behind, and its
// GitHub access. Listing reads only what the desktop already holds, so opening
// the page never wakes a sleeping box: connecting one is a click, and so is
// everything that changes a box. Here too the desktop's Lead chat is moved onto
// a box (client.leadBox), as the phone picks its Lead box in its own Boxes, and
// the boxes are let reach each other (client.crossBox, CrossBox.tsx).

const IPC_PREFIX = /^Error invoking remote method '[^']+': (Error: )?/;
const errorText = (e: unknown) =>
	(e instanceof Error ? e.message : String(e)).replace(IPC_PREFIX, "");

function statusLine(row: BoxRow, now: number): string {
	if (row.state === "connected") return "Connected";
	if (row.state === "asleep") return "Asleep";
	if (row.failure === NEEDS_PAIRING) return "Locked: this Mac needs pairing";
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
	// alias → the pairing code being typed for a locked box.
	const [codes, setCodes] = useState<Record<string, string>>({});
	const { ui: promptUi, confirm } = usePrompt();
	const leadHome = useLeadHome();

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
		const offConnections = window.ateamHost.onConnectionsChanged(() => void load());
		const offGithub = window.ateamHost.onGithubChanged(() => void load());
		return () => {
			offConnections();
			offGithub();
		};
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

	const pairWithCode = (row: BoxRow) =>
		act(row.alias, "Pairing…", async () => {
			await window.ateamHost.connect(row.alias, { code: codes[row.alias] ?? "" });
			setCodes(({ [row.alias]: _, ...rest }) => rest);
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

	const moveLead = async (row: BoxRow | null) => {
		if (row) {
			const ok = await confirm(
				`Run the Lead on ${row.title}?`,
				`The desktop's Lead chat becomes ${row.title}'s own Lead, the conversation your phone has when it picks ${row.title} as its Lead box. It sees ${row.title}'s tasks only, uses the Claude account signed in there, and keeps the conversation and its attachments on the box. This Mac's conversation stays as it is, and moving back shows it again.`,
			);
			if (!ok) return;
		}
		const alias = row?.alias ?? leadHome.box;
		if (!alias) return;
		await act(alias, row ? "Moving the Lead…" : "Moving it back…", async () => {
			await window.ateamLead.setHome(row ? row.alias : null);
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
			{rows.length > 1 ? <CrossBox confirm={confirm} /> : null}
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
									{leadHome.box === row.alias ? <span className="box-card-tag">Lead</span> : null}
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
										{row.state !== "connected" && row.failure !== NEEDS_PAIRING ? (
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
							<div className="box-card-label">Lead</div>
							{leadHome.box === row.alias ? (
								<div className="box-lead-row">
									<span className="gh-access-muted">
										The desktop's Lead chat runs here. Your phone shares it when it picks this box
										as its Lead box.
									</span>
									<Button size="xs" variant="outline" onClick={() => void moveLead(null)}>
										Back to this Mac
									</Button>
								</div>
							) : row.state !== "connected" ? (
								<div className="gh-access-muted">Connect to run the Lead here.</div>
							) : !row.leadReady ? (
								<div className="gh-access-muted">Update the box to run the Lead here.</div>
							) : (
								<div className="box-lead-row">
									<span className="gh-access-muted">
										One Lead conversation with your phone, going on while this Mac sleeps. It sees
										this box's tasks only.
									</span>
									<Button size="xs" variant="outline" onClick={() => void moveLead(row)}>
										Run the Lead here
									</Button>
								</div>
							)}
						</div>
						<div className="box-card-section">
							<div className="box-card-label">Access</div>
							{row.failure === NEEDS_PAIRING && row.state !== "connected" ? (
								<form
									className="box-lead-row"
									onSubmit={(e) => {
										e.preventDefault();
										void pairWithCode(row);
									}}
								>
									<span className="gh-access-muted">
										It's locked to its paired devices. Enter a code from one of them (Pair a phone
										on another Mac, or `ateam pair` in the box's terminal).
									</span>
									<input
										className="box-pair-input"
										placeholder="XXXX-XXXX"
										aria-label="Pairing code"
										value={codes[row.alias] ?? ""}
										onChange={(e) => setCodes((c) => ({ ...c, [row.alias]: e.target.value }))}
									/>
									<Button
										size="xs"
										variant="outline"
										type="submit"
										disabled={!(codes[row.alias] ?? "").trim() || !!busy[row.alias]}
									>
										Pair
									</Button>
								</form>
							) : row.state !== "connected" ? (
								<div className="gh-access-muted">Connect to see who can use it.</div>
							) : !row.pairingReady ? (
								<div className="gh-access-muted">
									Update the box to lock it to your devices. Until then anyone who can reach its
									network port can use it.
								</div>
							) : (
								<BoxAccess alias={row.alias} title={row.title} confirm={confirm} />
							)}
						</div>
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
