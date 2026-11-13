import {
	type ConnectionDTO,
	type CredentialsResult,
	type GithubAccessDTO,
	githubAccessProblem,
	NEEDS_PAIRING,
	PROTOCOL_VERSION,
	relativeAge,
} from "@ateam/protocol";
import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BoxReadiness, HostStatus } from "../../../shared/host";
import { type BoxRow, boxRows, engineLabel } from "../boxes-settings";
import { stripAnsi } from "../lib/ansi";
import { setUpPhoneAccess } from "../lib/box-actions";
import { type BoxSetup, dismissSetup, useSetup } from "../lib/setups";
import { useLeadHome } from "../useLeadHome";
import { BoxAccess } from "./BoxAccess";
import { BoxDotfiles } from "./Dotfiles";
import { GithubAccess } from "./GithubAccess";
import { Button } from "./ui/button";
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from "./ui/dialog";
import { usePrompt } from "./usePrompt";

// A box's own page: where it stands, what's left before agents can work there, and
// everything that changes it (Lead, Access, GitHub). Settings → Boxes opens it from its
// list, and from a set-up that just finished there; New task's Run on shows the same page
// in a dialog over the task being written, so its draft stays. One place per action:
// the "Finish setting it up" list says what's left and where, the sections hold the
// controls.

const IPC_PREFIX = /^Error invoking remote method '[^']+': (Error: )?/;
export const errorText = (e: unknown) =>
	(e instanceof Error ? e.message : String(e)).replace(IPC_PREFIX, "");

export function statusLine(row: BoxRow, now: number): string {
	if (row.state === "connected") return "Connected";
	if (row.state === "asleep") return "Asleep";
	if (row.failure === NEEDS_PAIRING) return "Private: this Mac needs pairing";
	if (row.failure) return `Couldn't connect: ${row.failure}`;
	const age = relativeAge(row.lastSeen, now);
	return age
		? `Not connected, last seen ${age === "just now" ? age : `${age} ago`}`
		: "Not connected";
}

/**
 * Every box this Mac has used, kept current. Listing reads only what the desktop already
 * holds, so it never wakes a sleeping box. Loads can overlap (an action's own reload and
 * the broadcast of a box reconnecting after it), and only the latest may land: an older
 * read showed a box that was back as "Not connected" until the page was opened again.
 */
export function useBoxes() {
	const [connections, setConnections] = useState<ConnectionDTO[] | null>(null);
	const [held, setHeld] = useState<HostStatus[]>([]);
	const [failures, setFailures] = useState<Record<string, string>>({});
	const [canUpdateSsh, setCanUpdateSsh] = useState(false);
	const [appRelease, setAppRelease] = useState("");
	const [github, setGithub] = useState<Record<string, GithubAccessDTO>>({});
	const loads = useRef(0);
	const load = useCallback(async () => {
		const seq = ++loads.current;
		const [list, connected, failed, updatable, release, githubByBox] = await Promise.all([
			window.ateamHost.list(),
			window.ateamHost.connected(),
			window.ateamHost.failures(),
			window.ateamHost.canUpdateBoxes(),
			window.ateamHost.appRelease(),
			window.ateamHost.boxGithub(),
		]);
		if (seq !== loads.current) return;
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
	const rows =
		connections === null
			? null
			: boxRows(connections, held, failures, { protocol: PROTOCOL_VERSION, release: appRelease });
	return { rows, github, canUpdateSsh, load };
}

type Confirm = (title: string, body: string) => Promise<boolean>;

/** What a box's actions are doing (alias → "Connecting…") and how each last ended. */
export function useBoxActions(load: () => Promise<void>, confirm: Confirm) {
	const [busy, setBusy] = useState<Record<string, string>>({});
	const [notes, setNotes] = useState<Record<string, { text: string; error: boolean }>>({});
	// alias → the pairing code being typed for a locked box.
	const [codes, setCodes] = useState<Record<string, string>>({});
	const leadHome = useLeadHome();

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

	return {
		busy,
		notes,
		codes,
		leadBox: leadHome.box,
		setCode: (alias: string, code: string) => setCodes((c) => ({ ...c, [alias]: code })),

		connect: (row: BoxRow) =>
			act(row.alias, row.state === "asleep" ? "Waking…" : "Connecting…", async () => {
				await window.ateamHost.connect(row.alias, { wake: true });
				return null;
			}),

		setAlwaysOn: (row: BoxRow, on: boolean) =>
			act(row.alias, on ? "Keeping it on…" : "Letting it sleep…", async () => {
				const { sleeps } = await window.ateamHost.setBoxAlwaysOn(row.alias, on);
				// Asked to sleep but still up: this Mac's idle sleep of "never" is pushed to it.
				return !on && sleeps === false
					? "It stays up: idle sleep is set to never in Settings, and that applies to this box too."
					: null;
			}),

		pairWithCode: (row: BoxRow) =>
			act(row.alias, "Pairing…", async () => {
				await window.ateamHost.connect(row.alias, { code: codes[row.alias] ?? "" });
				setCodes(({ [row.alias]: _, ...rest }) => rest);
				return null;
			}),

		update: async (row: BoxRow) => {
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
		},

		phoneAccess: async (row: BoxRow) => {
			const ok = await confirm(
				`Reach ${row.title} from your phone?`,
				`Ateam runs its installer on ${row.title} again to join it to your tailnet, installing Tailscale there if it's missing, and opens its network port on the tailnet. Your browser opens Tailscale's page to approve the box: sign in with the account your iPhone uses (no account yet? the page makes one, free for personal use) and press Connect. It needs passwordless sudo on the box, and agents running there keep running.`,
			);
			if (!ok) return;
			await act(row.alias, "Joining your tailnet…", async () => {
				const status = await setUpPhoneAccess(row.alias, (url) =>
					setNotes((n) => ({
						...n,
						[row.alias]: {
							text: `Approve ${row.title} on the Tailscale page that opened in your browser (press Connect at the end), or open ${url}`,
							error: false,
						},
					})),
				);
				const at = status.info.wsAddr;
				return at
					? `On your tailnet. In Ateam Go, add the box at ${at}, on an iPhone with Tailscale on and signed in to the same account. Lock it below so only your devices can use it.`
					: "On your tailnet. Lock it below so only your devices can use it.";
			});
		},

		/** Resolves true once the box is gone from the list. */
		forget: async (row: BoxRow): Promise<boolean> => {
			const ok = await confirm(
				`Remove ${row.title} from this list?`,
				"The box and everything on it stay as they are. Ateam stops showing it until you connect to it again.",
			);
			if (!ok) return false;
			let gone = false;
			await act(row.alias, "Removing…", async () => {
				await window.ateamHost.forget(row.alias);
				gone = true;
				return null;
			});
			return gone;
		},

		moveLead: async (row: BoxRow | null) => {
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
		},
	};
}

export type BoxActions = ReturnType<typeof useBoxActions>;

/** When a Tailscale key expires, as a person reads a date. */
const dateOf = (iso: string) =>
	new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

/**
 * What's left before agents can work on a connected box, and where each thing is done.
 * The phone port and agents come from the box's handshake; GitHub from its access; the
 * git identity and Tailscale's key expiry from one SSH probe (boxReadiness), read again
 * when the GitHub access or the port changes.
 */
function BoxFinish({
	row,
	access,
	keys,
}: {
	row: BoxRow;
	access: GithubAccessDTO | undefined;
	keys: BoxKeys;
}) {
	const [ready, setReady] = useState<BoxReadiness | null>(null);
	const [names, setNames] = useState<Record<string, string>>({});
	const githubKey = JSON.stringify(access ?? null);
	useEffect(() => {
		void window.ateam.agents
			.list()
			.then((list) => setNames(Object.fromEntries(list.map((a) => [a.id, a.label]))))
			.catch(() => {});
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: githubKey and the port are why it reads again
	useEffect(() => {
		// The probe runs over SSH; a box added by its Tailscale address has none.
		if (row.transport !== "ssh") return;
		let live = true;
		void window.ateamHost.boxReadiness(row.alias).then(
			(r) => live && setReady(r),
			() => {},
		);
		return () => {
			live = false;
		};
	}, [row.alias, row.transport, githubKey, row.networkPort]);

	const port = row.networkPort;
	const agents = row.agents ?? [];
	const githubOk = access ? githubAccessProblem(access) === null : null;
	const expiry = ready?.tailscaleKeyExpiry;
	const left =
		(port === null && row.transport === "ssh") ||
		Boolean(expiry) ||
		githubOk === false ||
		(ready !== null && !ready.gitName) ||
		agents.length === 0;
	const first = agents.includes("claude") ? "claude" : agents[0];
	// Optional, so it never turns "Ready for tasks" back into a to-do list.
	const hasKey = keys && keys !== "failed" ? hasAiKey(keys) : null;

	return (
		<div className="box-card-section">
			<div className="box-card-label">{left ? "Finish setting it up" : "Ready for tasks"}</div>
			<ul className="box-ready-list">
				<li className="done">Engine{row.release ? ` ${row.release}` : ""}, connected</li>
				{port === undefined ? null : port ? (
					<li className="done">
						Ateam Go reaches it at <code>{port}</code>: add it there by that address, on an iPhone
						with Tailscale on and signed in to the same account.
					</li>
				) : row.transport === "ssh" ? (
					<li className="todo">
						Ateam Go can't reach it yet: <b>Set up phone access</b>, under Access.
					</li>
				) : null}
				{expiry ? (
					<li className="todo">
						Tailscale drops it from your tailnet on {dateOf(expiry)}. Turn its key expiry off in
						Tailscale's Machines page (this box → ⋯ → Disable key expiry).{" "}
						<button
							type="button"
							className="cb-link"
							onClick={() =>
								void window.ateamHost.openConsole("https://console.tailscale.com/admin/machines")
							}
						>
							Open Tailscale's machines
						</button>
					</li>
				) : null}
				{githubOk === null ? null : githubOk ? (
					<li className="done">
						GitHub connected{access?.gh?.login ? ` as ${access.gh.login}` : ""}
					</li>
				) : (
					<li className="todo">
						GitHub isn't connected yet: connect it under GitHub, so it can clone and push.
					</li>
				)}
				{ready === null ? null : ready.gitName ? (
					<li className="done">git identity: {ready.gitName}</li>
				) : (
					<li className="todo">
						git identity: sets itself from your GitHub account once GitHub is connected
					</li>
				)}
				{agents.length === 0 ? (
					<li className="todo">
						No coding agent yet: install one from the agent picker in New task.
					</li>
				) : (
					<li className="done">
						{agents.map((a) => names[a] ?? a).join(", ")} installed. Sign in once from a terminal:{" "}
						<code>
							ssh -t {row.alias} {first}
						</code>
					</li>
				)}
				{/* No tick when a key is set: a key the provider refuses (an OpenRouter account
				    that blocks the decision model, a revoked or capped key) reads the same here. */}
				{hasKey === false ? (
					<li className="todo">
						Optional: no AI key, so finished tasks won't move to Needs you. Add one under AI keys.
					</li>
				) : null}
			</ul>
		</div>
	);
}

/** A set-up over SSH, as it goes: its log while it runs, why it stopped if it failed. */
function SetupProgress({ setup, onDismiss }: { setup: BoxSetup; onDismiss: () => void }) {
	const logRef = useRef<HTMLPreElement>(null);
	// Keep the newest line in view as the log grows.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the log is why it scrolls
	useEffect(() => {
		if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
	}, [setup.log]);
	return (
		<div className="box-card-section">
			<div className="box-card-label">
				{setup.state === "failed" ? "Couldn't set it up" : "Setting it up over SSH"}
			</div>
			{setup.state === "failed" ? (
				<div className="box-lead-row">
					<span className="gh-access-problem">{setup.error}</span>
					<span className="box-card-actions">
						<Button size="xs" variant="ghost" onClick={onDismiss}>
							Dismiss
						</Button>
						<Button size="xs" variant="outline" onClick={setup.retry}>
							Try again
						</Button>
					</span>
				</div>
			) : (
				<span className="gh-access-muted">
					Installing Ateam's engine on it. This keeps going if you leave this page.
				</span>
			)}
			{setup.log ? (
				<pre ref={logRef} className="cb-log">
					{stripAnsi(setup.log)}
				</pre>
			) : null}
		</div>
	);
}

/** The page of a box still being set up, before it's one of the boxes. */
export function BoxSetupPage({ setup, onBack }: { setup: BoxSetup; onBack?: () => void }) {
	return (
		<section className="box-page" aria-label={setup.dest}>
			<div className="box-card-head">
				<div className="box-card-text">
					<div className="box-card-title">{setup.dest}</div>
					<div className="box-card-status">
						{setup.state === "failed"
							? "Not set up"
							: setup.state === "done"
								? "Set up, connecting…"
								: "Setting up…"}
					</div>
				</div>
			</div>
			{setup.state === "done" ? null : (
				<SetupProgress
					setup={setup}
					onDismiss={() => {
						dismissSetup(setup.dest);
						onBack?.();
					}}
				/>
			)}
		</section>
	);
}

/** A box's page: the header (status, engine, actions), what's left, and its sections. */
export function BoxPage({
	row,
	access,
	needsYou,
	canUpdateSsh,
	actions,
	confirm,
	onBack,
}: {
	row: BoxRow;
	access: GithubAccessDTO | undefined;
	needsYou: boolean;
	canUpdateSsh: boolean;
	actions: BoxActions;
	confirm: Confirm;
	/** Back to the list, once the box is forgotten; none in the dialog. */
	onBack?: () => void;
}) {
	const note = actions.notes[row.alias];
	const busy = actions.busy[row.alias];
	const setup = useSetup(row.alias);
	const keys = useBoxKeys(row.alias, row.state === "connected");
	const canUpdate =
		row.state === "connected" &&
		row.engine === "behind" &&
		(row.transport === "ws" || canUpdateSsh);
	return (
		<section className="box-page" aria-label={row.title}>
			<div className="box-card-head">
				<div className="box-card-text">
					<div className="box-card-title">
						{row.title}
						{actions.leadBox === row.alias ? <span className="box-card-tag">Lead</span> : null}
						{needsYou ? <span className="box-card-dot" role="img" aria-label="needs you" /> : null}
					</div>
					<div className="box-card-detail">{row.detail}</div>
					<div className="box-card-status">
						<span className={`box-card-state ${row.state}`}>{statusLine(row, Date.now())}</span>
						{" · "}
						<span className={row.engine === "behind" ? "box-card-behind" : undefined}>
							{engineLabel(row)}
						</span>
					</div>
				</div>
				<div className="box-card-actions">
					{busy ? (
						<span className="gh-access-muted">{busy}</span>
					) : (
						<>
							{row.state !== "connected" && row.failure !== NEEDS_PAIRING ? (
								<Button size="xs" variant="outline" onClick={() => void actions.connect(row)}>
									Connect
								</Button>
							) : null}
							{canUpdate ? (
								<Button size="xs" variant="outline" onClick={() => void actions.update(row)}>
									Update
								</Button>
							) : null}
							<Button
								size="xs"
								variant="ghost"
								onClick={() =>
									void actions.forget(row).then((gone) => {
										if (gone) onBack?.();
									})
								}
							>
								Forget
							</Button>
						</>
					)}
				</div>
			</div>
			{note ? (
				<div className={note.error ? "gh-access-problem" : "gh-access-muted"}>{note.text}</div>
			) : null}
			{setup && setup.state !== "done" ? (
				<SetupProgress setup={setup} onDismiss={() => dismissSetup(row.alias)} />
			) : row.state === "connected" ? (
				<BoxFinish row={row} access={access} keys={keys} />
			) : null}
			<div className="box-card-section">
				<div className="box-card-label">Lead</div>
				{actions.leadBox === row.alias ? (
					<div className="box-lead-row">
						<span className="gh-access-muted">
							The desktop's Lead chat runs here. Your phone shares it when it picks this box as its
							Lead box.
						</span>
						<Button size="xs" variant="outline" onClick={() => void actions.moveLead(null)}>
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
							One Lead conversation with your phone, going on while this Mac sleeps. It sees this
							box's tasks only.
						</span>
						<Button size="xs" variant="outline" onClick={() => void actions.moveLead(row)}>
							Run the Lead here
						</Button>
					</div>
				)}
			</div>
			{row.sleeps === null ? null : (
				<div className="box-card-section">
					<div className="box-card-label">Sleep</div>
					{row.state !== "connected" ? (
						<div className="gh-access-muted">Connect to choose whether it sleeps.</div>
					) : row.sleeps === undefined ? (
						<div className="gh-access-muted">
							Update the box to choose whether it sleeps from here.
						</div>
					) : (
						<div className="box-lead-row">
							<span className="gh-access-muted">
								{row.sleeps
									? "Sleeps when idle, after the idle time in Settings, and wakes when you use it. Waking it from Ateam Go needs your provider's key there."
									: "Always on: it never sleeps, so nothing needs a key to wake it. It's billed around the clock."}
							</span>
							<Button
								size="xs"
								variant="outline"
								disabled={!!busy}
								onClick={() => void actions.setAlwaysOn(row, row.sleeps === true)}
							>
								{row.sleeps ? "Keep it always on" : "Let it sleep when idle"}
							</Button>
						</div>
					)}
				</div>
			)}
			<div className="box-card-section">
				<div className="box-card-label">Access</div>
				{row.failure === NEEDS_PAIRING && row.state !== "connected" ? (
					<form
						className="box-lead-row"
						onSubmit={(e) => {
							e.preventDefault();
							void actions.pairWithCode(row);
						}}
					>
						<span className="gh-access-muted">
							It's private to its paired devices. Enter a code from one of them (Pair a phone on
							another Mac, or `ateam pair` in the box's terminal).
						</span>
						<input
							className="box-pair-input"
							placeholder="XXXX-XXXX"
							aria-label="Pairing code"
							value={actions.codes[row.alias] ?? ""}
							onChange={(e) => actions.setCode(row.alias, e.target.value)}
						/>
						<Button
							size="xs"
							variant="outline"
							type="submit"
							disabled={!(actions.codes[row.alias] ?? "").trim() || !!busy}
						>
							Pair
						</Button>
					</form>
				) : row.state !== "connected" ? (
					<div className="gh-access-muted">Connect to see who can use it.</div>
				) : row.networkPort === null && row.transport === "ssh" ? (
					<div className="box-lead-row">
						<span className="gh-access-muted">
							No network port: only this Mac reaches it, over SSH. Ateam Go and your other boxes
							can't.
						</span>
						<Button
							size="xs"
							variant="outline"
							disabled={!!busy}
							onClick={() => void actions.phoneAccess(row)}
						>
							Set up phone access
						</Button>
					</div>
				) : !row.pairingReady ? (
					<div className="gh-access-muted">
						Update the box to lock it to your devices. Until then anyone who can reach its network
						port can use it.
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
			<div className="box-card-section">
				<div className="box-card-label">AI keys</div>
				<BoxAiKeys keys={keys} connected={row.state === "connected"} />
			</div>
			<BoxDotfiles
				alias={row.alias}
				label={row.title}
				version={row.version}
				connected={row.state === "connected"}
			/>
		</section>
	);
}

/** A connected box's own key status: null while asking (or not connected), "failed"
 *  when it couldn't say. */
type BoxKeys = CredentialsResult | "failed" | null;

function hasAiKey(keys: CredentialsResult): boolean {
	return keys.openRouter.set || keys.openAi?.set === true;
}

/** Asked of the box itself (each box keeps its own keys), once per opening of its page. */
function useBoxKeys(alias: string, connected: boolean): BoxKeys {
	const [keys, setKeys] = useState<BoxKeys>(null);
	useEffect(() => {
		setKeys(null);
		if (!connected) return;
		let live = true;
		window.ateamHost.boxCredentials(alias).then(
			(r) => live && setKeys(r),
			() => live && setKeys("failed"),
		);
		return () => {
			live = false;
		};
	}, [alias, connected]);
	return keys;
}

/**
 * Which AI keys the box itself holds, asked of that box (each box keeps its own).
 * With neither, nothing on it moves a finished task to Needs you, and nothing else
 * on the board says why. Titles and summaries still come from Claude Code there.
 */
function BoxAiKeys({ keys, connected }: { keys: BoxKeys; connected: boolean }) {
	if (!connected) {
		return <div className="gh-access-muted">Connect to see which AI keys it has.</div>;
	}
	if (keys === null) return <div className="gh-access-muted">Checking…</div>;
	if (keys === "failed") return <div className="gh-access-muted">Couldn't read its AI keys.</div>;
	const held = [
		keys.openAi?.set ? `OpenAI key …${keys.openAi.hint ?? ""}` : null,
		keys.openRouter.set
			? `OpenRouter key …${keys.openRouter.hint ?? ""}${keys.openRouter.source === "env" ? " (from OPENROUTER_API_KEY)" : ""}`
			: null,
	].filter((k): k is string => k !== null);
	if (!hasAiKey(keys)) {
		return (
			<div className="gh-access-warn">
				No AI key on this box: finished tasks won't move to Needs you when they wait on you. Add one
				in Settings → AI on this Mac: it's copied to your boxes when sync is on.
			</div>
		);
	}
	return <div className="gh-access-muted">{held.join(" · ")}</div>;
}

/**
 * A box's page over whatever is open (New task's Run on, after a set-up there), so the
 * task being written keeps its draft. Closing it returns there.
 */
export function BoxPageDialog({ alias, onClose }: { alias: string; onClose: () => void }) {
	const { rows, github, canUpdateSsh, load } = useBoxes();
	const { ui: promptUi, confirm } = usePrompt();
	const actions = useBoxActions(load, confirm);
	const row = rows?.find((r) => r.alias === alias);
	const setup = useSetup(alias);
	// Forgotten from here: the box is gone from the list, and so is its page. A box
	// still being set up isn't in the list yet.
	const gone = rows !== null && !row && !setup;
	useEffect(() => {
		if (gone) onClose();
	}, [gone, onClose]);
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogPortal>
				{/* Above New task's own overlay (z-index 100), which this opens over. */}
				<DialogOverlay className="z-[110]" />
				<DialogPrimitive.Content
					aria-describedby={undefined}
					className="box-page-dialog fixed top-1/2 left-1/2 z-[111] grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border bg-background p-6 shadow-lg outline-none sm:max-w-2xl"
				>
					<DialogTitle className="sr-only">{row?.title ?? alias}</DialogTitle>
					{promptUi}
					{row ? (
						<BoxPage
							row={row}
							access={github[alias]}
							needsYou={false}
							canUpdateSsh={canUpdateSsh}
							actions={actions}
							confirm={confirm}
						/>
					) : setup ? (
						<BoxSetupPage setup={setup} />
					) : (
						<div className="gh-access-muted">Loading {alias}…</div>
					)}
					<DialogPrimitive.Close
						className="box-page-close absolute top-4 right-4 opacity-70 transition-opacity hover:opacity-100 [&_svg]:size-4"
						aria-label="Close"
					>
						<XIcon />
					</DialogPrimitive.Close>
				</DialogPrimitive.Content>
			</DialogPortal>
		</Dialog>
	);
}
