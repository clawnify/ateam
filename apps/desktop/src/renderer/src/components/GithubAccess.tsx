import {
	broadTokenRevokeNote,
	cleanGithubToken,
	FINE_GRAINED_REPO_HINT,
	fineGrainedTokenUrl,
	type GithubAccessDTO,
	githubAccessProblem,
	githubAccessSummary,
	githubAccessUrgent,
	githubHelperWarning,
	githubTokenWouldHelp,
	pastedTokenLabel,
	type RepoAccessDTO,
	repoAccessLabel,
	repoVerdictHint,
	TOKEN_FORM_HINT,
	TOKEN_OWNER_RESET_HINT,
	tokenBoxName,
	tokenOwnerChoices,
	tokenOwnerNote,
} from "@ateam/protocol";
import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";

/** The token picker's "Other…" entry ("" is Ateam's guess). No GitHub login has a "…". */
const OTHER_OWNER = "other…";

// A box's GitHub access, and connecting a token to it without opening its terminal:
// who the box signs in as and with what kind of token, whether that token reaches
// more than it should, and per repository whether the box can push. The same
// component wherever a box's GitHub comes up (the set-up checklist, Settings, a Run
// on that can't clone), so every place says the same thing in the same words
// (@ateam/protocol github-access.ts, shared with the phone).
//
// The token is typed here, sent to the box once, and dropped from state as soon as
// the box has it. Nothing ever sends it back.

type Loaded =
	| { state: "loading" }
	/** The box's engine predates githubAccess (v25): sign in in its terminal. */
	| { state: "old" }
	| { state: "error"; message: string }
	| { state: "ready"; access: GithubAccessDTO };

const IPC_PREFIX = /^Error invoking remote method '[^']+': (Error: )?/;

export function GithubAccess({
	alias,
	label,
	repos,
	onAccess,
}: {
	/** The connected box, by its connection alias. */
	alias: string;
	/** How the box is named in sentences. */
	label: string;
	/** Repositories (`owner/name`) to check. Unset: the box's own projects. */
	repos?: string[];
	/** Each time the box's access is read: on opening, and after a token connects (`connected`). */
	onAccess?: (access: GithubAccessDTO, connected: boolean) => void;
}) {
	const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
	const [checks, setChecks] = useState<RepoAccessDTO[] | null>(null);
	const [checking, setChecking] = useState(false);
	const [formOpen, setFormOpen] = useState(false);
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Who the token is for: "" follows Ateam's guess, OTHER_OWNER takes otherOwner.
	const [ownerPick, setOwnerPick] = useState("");
	const [otherOwner, setOtherOwner] = useState("");
	// Owners for that choice beyond this box's own repositories: the user's other
	// projects, and a login another box reported, for a box whose gh isn't signed in.
	const [seenOwners, setSeenOwners] = useState<string[]>([]);
	const [otherLogin, setOtherLogin] = useState<string | null>(null);
	const reposKey = repos?.join("\n") ?? "";
	// The latest callback, without making every render reload the access.
	const onAccessRef = useRef(onAccess);
	onAccessRef.current = onAccess;

	const recheck = useCallback(async () => {
		const list = reposKey ? reposKey.split("\n") : undefined;
		setChecking(true);
		try {
			setChecks(await window.ateamHost.checkGithub(alias, list));
		} catch {
			setChecks(null); // the access line above still stands on its own
		} finally {
			setChecking(false);
		}
	}, [alias, reposKey]);

	const load = useCallback(async () => {
		setLoaded({ state: "loading" });
		try {
			const access = await window.ateamHost.githubAccess(alias);
			setLoaded({ state: "ready", access });
			onAccessRef.current?.(access, false);
		} catch (e) {
			const message = (e instanceof Error ? e.message : String(e)).replace(IPC_PREFIX, "");
			setLoaded(/Unknown method/.test(message) ? { state: "old" } : { state: "error", message });
			return;
		}
		await recheck();
	}, [alias, recheck]);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		let live = true;
		void Promise.all([
			window.ateam.projects.list().catch(() => []),
			window.ateamHost.boxGithub().catch(() => ({})),
		]).then(([projects, github]) => {
			if (!live) return;
			setSeenOwners(projects.flatMap((p) => (p.githubOwner ? [p.githubOwner] : [])));
			setOtherLogin(Object.values(github).find((a) => a.gh?.login)?.gh?.login ?? null);
		});
		return () => {
			live = false;
		};
	}, []);

	const connect = async () => {
		const clean = cleanGithubToken(token);
		if (!clean) {
			setError(
				"That doesn't look like a GitHub token. Copy the whole token: it starts with github_pat_.",
			);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const access = await window.ateamHost.connectGithub(alias, clean);
			setToken("");
			setFormOpen(false);
			setLoaded({ state: "ready", access });
			onAccessRef.current?.(access, true);
			await recheck();
		} catch (e) {
			setError((e instanceof Error ? e.message : String(e)).replace(IPC_PREFIX, ""));
		} finally {
			setBusy(false);
		}
	};

	if (loaded.state === "loading") {
		return <div className="gh-access gh-access-muted">Checking GitHub on {label}…</div>;
	}
	if (loaded.state === "old") {
		return (
			<div className="gh-access">
				<div className="gh-access-muted">
					This box's Ateam is too old to sign in to GitHub from here. Update the box, or run{" "}
					<code>gh auth login</code> in its terminal.
				</div>
			</div>
		);
	}
	if (loaded.state === "error") {
		return (
			<div className="gh-access">
				<div className="gh-access-problem">
					Couldn't read GitHub access on {label}: {loaded.message}
				</div>
				<div>
					<Button size="xs" variant="outline" onClick={() => void load()}>
						Try again
					</Button>
				</div>
			</div>
		);
	}

	const access = loaded.access;
	const problem = githubAccessProblem(access);
	const helperWarning = githubHelperWarning(access);
	const showForm = formOpen || githubTokenWouldHelp(access);
	const repoNames = checks?.map((c) => c.repo) ?? repos ?? [];
	const personal = access.gh?.login ?? otherLogin;
	const choices = tokenOwnerChoices({ boxRepos: repoNames, personal, seen: seenOwners });
	const owner =
		ownerPick === ""
			? choices.guess
			: ownerPick === OTHER_OWNER
				? otherOwner.trim() || null
				: ownerPick;
	// Said once the box's repositories are known, not while they load.
	const ownerNote =
		checks !== null || repos !== undefined
			? tokenOwnerNote({ boxRepos: repoNames, owner, personal })
			: null;
	const hint = repoVerdictHint(access, checks ?? []);

	return (
		<div className="gh-access">
			<div className="gh-access-head">
				<span className="gh-access-summary">{githubAccessSummary(access)}</span>
				{!showForm && access.ghInstalled && access.gh?.source !== "env" ? (
					<Button size="xs" variant="ghost" onClick={() => setFormOpen(true)}>
						Use a different token
					</Button>
				) : null}
			</div>
			{problem ? (
				<div className={`gh-access-problem${githubAccessUrgent(access) ? " urgent" : ""}`}>
					{problem}
				</div>
			) : null}
			{helperWarning ? <div className="gh-access-problem">{helperWarning}</div> : null}
			{access.unverified ? <div className="gh-access-muted">{access.unverified}</div> : null}

			{checks && checks.length > 0 ? (
				<ul className="gh-access-repos">
					{checks.map((c) => (
						<li key={c.repo} className={`gh-access-repo ${c.access}`}>
							<span className="gh-access-repo-name">{c.repo}</span>
							<span className="gh-access-repo-verdict">{repoAccessLabel(c.access)}</span>
						</li>
					))}
				</ul>
			) : null}
			{checking && !checks ? (
				<div className="gh-access-muted">Checking which projects it can push to…</div>
			) : null}
			{hint ? (
				<div className="gh-access-muted">
					{hint}
					{hint === FINE_GRAINED_REPO_HINT ? (
						<>
							{" "}
							<button
								type="button"
								className="gh-access-link"
								onClick={() =>
									void window.ateamHost.openGithub(
										"https://github.com/settings/personal-access-tokens",
									)
								}
							>
								Your tokens on GitHub
								<ExternalLink size={11} />
							</button>
						</>
					) : null}
				</div>
			) : null}

			{showForm ? (
				<div className="gh-access-form">
					<div className="gh-access-step">
						<span className="gh-access-step-n">1</span>
						<div className="gh-access-step-body">
							<div className="gh-access-owner">
								<span className="gh-access-muted">Token for</span>
								<NativeSelect
									size="sm"
									value={ownerPick}
									onChange={(e) => setOwnerPick(e.target.value)}
									aria-label="Who the token is for"
								>
									{choices.options.length === 0 ? (
										<option value="">the account signed in to GitHub</option>
									) : (
										choices.options.map((o) => (
											<option key={o} value={o === choices.guess ? "" : o}>
												{o === personal ? `${o} (you)` : o}
											</option>
										))
									)}
									<option value={OTHER_OWNER}>Other…</option>
								</NativeSelect>
								{ownerPick === OTHER_OWNER ? (
									<Input
										className="gh-access-owner-input"
										value={otherOwner}
										onChange={(e) => setOtherOwner(e.target.value)}
										placeholder="user or organization"
										aria-label="Owner on GitHub"
										autoFocus
										spellCheck={false}
									/>
								) : null}
							</div>
							{ownerNote ? (
								<span className={repoNames.length > 0 ? "gh-access-warn" : "gh-access-muted"}>
									{ownerNote}
								</span>
							) : null}
							<Button
								size="sm"
								variant="outline"
								onClick={() =>
									void window.ateamHost.openGithub(
										fineGrainedTokenUrl({ box: tokenBoxName(label, access.hostname), owner }),
									)
								}
							>
								Create a token on GitHub
								<ExternalLink size={12} />
							</Button>
							<span className="gh-access-muted">{TOKEN_FORM_HINT}</span>
							<span className="gh-access-muted">{TOKEN_OWNER_RESET_HINT}</span>
						</div>
					</div>
					<div className="gh-access-step">
						<span className="gh-access-step-n">2</span>
						<div className="gh-access-step-body gh-access-paste">
							<Input
								type="password"
								className="h-7 text-[13px]"
								placeholder="Paste the token (github_pat_…)"
								aria-label={`GitHub token for ${label}`}
								autoComplete="off"
								spellCheck={false}
								value={token}
								disabled={busy}
								onChange={(e) => {
									setToken(e.target.value);
									setError(null);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" && token.trim()) void connect();
								}}
							/>
							<Button size="sm" disabled={busy || !token.trim()} onClick={() => void connect()}>
								{busy ? "Connecting…" : "Connect"}
							</Button>
						</div>
					</div>
					{pastedTokenLabel(token) && !error ? (
						<div className="gh-access-muted gh-access-pasted">{pastedTokenLabel(token)}</div>
					) : null}
					{error ? <div className="gh-access-problem">{error}</div> : null}
					<div className="gh-access-muted">
						The token goes to {label} only, where gh keeps it. Agents there can read it, which is
						why it should reach only this box's repositories.
					</div>
					{broadTokenRevokeNote(access) ? (
						<div className="gh-access-muted">{broadTokenRevokeNote(access)}</div>
					) : null}
					{/* Opened by hand on a box that needs nothing: let it close again. */}
					{!githubTokenWouldHelp(access) ? (
						<div>
							<Button
								size="xs"
								variant="ghost"
								disabled={busy}
								onClick={() => {
									setFormOpen(false);
									setToken("");
									setError(null);
								}}
							>
								Keep the current token
							</Button>
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
