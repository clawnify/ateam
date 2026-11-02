import {
	broadTokenRevokeNote,
	cleanGithubToken,
	FINE_GRAINED_REPO_HINT,
	fineGrainedTokenUrl,
	type GithubAccessDTO,
	githubAccessProblem,
	githubAccessSummary,
	githubTokenWouldHelp,
	mostCommonOwner,
	pastedTokenLabel,
	type RepoAccessDTO,
	repoAccessLabel,
	repoVerdictHint,
} from "@ateam/protocol";
import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";

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
	const showForm = formOpen || githubTokenWouldHelp(access);
	const repoNames = checks?.map((c) => c.repo) ?? repos ?? [];
	const owner = mostCommonOwner(repoNames) ?? access.gh?.login ?? null;
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
			{problem ? <div className="gh-access-problem">{problem}</div> : null}
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
							<Button
								size="sm"
								variant="outline"
								onClick={() =>
									void window.ateamHost.openGithub(fineGrainedTokenUrl({ box: label, owner }))
								}
							>
								Create a token on GitHub
								<ExternalLink size={12} />
							</Button>
							<span className="gh-access-muted">
								Ateam fills in the name, 90 days and its permissions. Choose the repositories this
								box works on, then Generate token and copy it.
							</span>
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

/**
 * Settings' way in: every connected box's GitHub access in one dialog, for the
 * visits that come after setting a box up (a token that expired, a repository to
 * add, a full-access login to swap for a scoped token).
 */
export function GithubBoxesButton() {
	const [open, setOpen] = useState(false);
	const [boxes, setBoxes] = useState<string[] | null>(null);
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setBoxes(null);
		window.ateamHost
			.connected()
			.then((held) => {
				if (!cancelled) setBoxes(held.flatMap((s) => (s.alias ? [s.alias] : [])));
			})
			.catch(() => {
				if (!cancelled) setBoxes([]);
			});
		return () => {
			cancelled = true;
		};
	}, [open]);
	return (
		<>
			<Button size="sm" variant="outline" onClick={() => setOpen(true)}>
				Manage
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent
					className="flex max-h-[calc(100vh-4rem)] flex-col gap-4 overflow-y-auto p-5 sm:max-w-[560px]"
					aria-describedby={undefined}
				>
					<DialogTitle className="pr-8 text-sm font-medium">GitHub on your boxes</DialogTitle>
					{boxes === null ? (
						<div className="gh-access-muted">Loading…</div>
					) : boxes.length === 0 ? (
						<div className="gh-access-muted">
							No box is connected right now. Boxes show here while they're connected.
						</div>
					) : (
						boxes.map((alias) => (
							<section key={alias} className="gh-access-box">
								<h4 className="gh-access-box-name">{alias}</h4>
								<GithubAccess alias={alias} label={alias} />
							</section>
						))
					)}
				</DialogContent>
			</Dialog>
		</>
	);
}
