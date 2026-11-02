// GitHub access on an engine's machine (v25): what githubAccess:* answers, and
// the few pure helpers both clients use to talk about it, so the desktop and the
// phone say the same thing about the same token.
//
// Agents on a box run as the same user as its engine, so any credential gh or git
// can use, an agent can read. Hiding the token is not the lever; its reach is.
// That is why these DTOs carry each credential's kind and, per repo, whether it
// can push, and never the token itself (only its last four characters).

/** A GitHub credential's kind, read from its prefix. */
export type GithubCredentialKind =
	/** `github_pat_`: only the repositories and permissions picked for it, and it expires. */
	| "fine-grained"
	/** `ghu_`/`ghs_`: a GitHub App's token, limited to where the App is installed. */
	| "app"
	/** `gho_`: gh's browser login or a provider's integration. Every repo the account can reach. */
	| "oauth"
	/** `ghp_`: a classic token. Every repo its scopes allow. */
	| "classic"
	| "unknown";

/** One GitHub credential as the engine's machine holds it. Never the token itself. */
export interface GithubCredentialDTO {
	kind: GithubCredentialKind;
	/** The last four characters, to tell tokens apart. */
	hint: string;
	/** Whose it is, per GitHub. Null when GitHub refused it or could not be asked. */
	login: string | null;
	/** GitHub refused it: expired, revoked or mistyped. */
	rejected: boolean;
	/** When it expires (ms since epoch), when GitHub says so. */
	expiresAt: number | null;
}

/** `githubAccess:status`: which GitHub credentials gh and git use on the engine's machine. */
export interface GithubAccessDTO {
	/** `gh` is installed. Without it Ateam can neither set a token up nor open pull requests. */
	ghInstalled: boolean;
	/**
	 * What `gh` signs in with. Ateam's pull requests, merges and issues go through it.
	 * `env` when GH_TOKEN or GITHUB_TOKEN in the engine's environment supplies it,
	 * which a token connected from Ateam cannot override.
	 */
	gh: (GithubCredentialDTO & { source: "store" | "env" }) | null;
	/**
	 * How git signs in to github.com when it clones and pushes: with gh's token, with
	 * a different token from another credential helper (a provider's, like boxd's),
	 * or not at all, in which case pushing to a private repository fails.
	 */
	git: "gh" | "other" | "none";
	/** The other helper's token when `git` is "other": what clone and push actually use. */
	gitCredential: GithubCredentialDTO | null;
	/** Why GitHub could not be asked (offline, say). Logins and refusals are then unknown. */
	unverified: string | null;
}

/** Whether a credential can push to a repository, only read it, or not see it at all. */
export type RepoAccess = "push" | "read" | "none" | "unknown";

/** `githubAccess:check`: one repository's verdict. */
export interface RepoAccessDTO {
	/** `owner/name`. */
	repo: string;
	/** "unknown" when GitHub could not be asked. */
	access: RepoAccess;
}

/** Classic and OAuth tokens reach everything their account can, not just this box's repos. */
export function isBroadCredential(kind: GithubCredentialKind): boolean {
	return kind === "oauth" || kind === "classic";
}

/** How a credential's kind reads in a sentence ("signed in with a fine-grained token"). */
export function credentialKindLabel(kind: GithubCredentialKind): string {
	switch (kind) {
		case "fine-grained":
			return "a fine-grained token";
		case "app":
			return "a GitHub App token";
		case "oauth":
			return "a full-access login token";
		case "classic":
			return "a classic token";
		default:
			return "a token";
	}
}

/** One line on what a repository verdict means for a task on this box. */
export function repoAccessLabel(access: RepoAccess): string {
	switch (access) {
		case "push":
			return "can push";
		case "read":
			return "read only: can clone, can't push";
		case "none":
			return "can't see it";
		default:
			return "couldn't check";
	}
}

/** Who the box signs in as, and with what, in one line. */
export function githubAccessSummary(a: GithubAccessDTO, now: number = Date.now()): string {
	const own = a.gh ?? (a.git === "other" ? a.gitCredential : null);
	if (!own) return a.ghInstalled ? "Not connected to GitHub" : "GitHub CLI (gh) not installed";
	const who = own.login ? `Signed in as ${own.login}` : "Signed in";
	const expiry = own.expiresAt ? `, ${expiryPhrase(own.expiresAt, now)}` : "";
	const via = a.gh ? "" : " (through another credential helper)";
	return `${who} with ${credentialKindLabel(own.kind)} ending ${own.hint}${via}${expiry}`;
}

/**
 * The one thing wrong with a box's GitHub access, worst first, or null when nothing
 * is. Every client shows this same sentence above its Connect form.
 */
export function githubAccessProblem(a: GithubAccessDTO): string | null {
	if (!a.ghInstalled) {
		return "This box has no GitHub CLI (gh). Update the box to install it.";
	}
	if (a.gh?.rejected) {
		return "GitHub refused this box's token: it expired or was revoked. Connect a new one.";
	}
	if (!a.gh && a.git !== "other") {
		return "Connect GitHub so this box can clone, push and open pull requests.";
	}
	if (a.gh?.source === "env") {
		return "GH_TOKEN in the engine's environment decides which token gh uses here, so a token connected from Ateam would be ignored.";
	}
	if (a.gh && isBroadCredential(a.gh.kind)) {
		return "This token reaches every repository your account can, and agents on this box can read it. A fine-grained token limited to this box's repositories is safer.";
	}
	if (a.gh && a.git === "none") {
		return "git can't sign in to GitHub here, so pushing fails. Connect the token again to fix it.";
	}
	const helper = otherHelperWarning(a);
	if (helper) return helper;
	if (!a.gh) {
		return "gh isn't signed in, so Ateam can't open pull requests or merge from this box. Connect a token.";
	}
	return null;
}

/** The warning for a provider's git helper handing out a broad token, when it does. */
function otherHelperWarning(a: GithubAccessDTO): string | null {
	return a.git === "other" && a.gitCredential && isBroadCredential(a.gitCredential.kind)
		? `git on this box signs in through another credential helper, likely your provider's, with a full-access token ending ${a.gitCredential.hint}. Agents can fetch it, so disconnect it at the provider to leave only a scoped token.`
		: null;
}

/**
 * Whether pasting a token would fix what's wrong, so a client opens its Connect
 * form unasked. Not when the fix is elsewhere: a box without gh needs an update,
 * GH_TOKEN in the engine's environment would ignore the token, and a provider's
 * git helper is disconnected at the provider.
 */
export function githubTokenWouldHelp(a: GithubAccessDTO): boolean {
	if (!a.ghInstalled || a.gh?.source === "env") return false;
	return !a.gh || a.gh.rejected || isBroadCredential(a.gh.kind) || a.git === "none";
}

/** The owner most of these `owner/name` repositories belong to: who a new token is for. */
export function mostCommonOwner(repos: readonly string[]): string | null {
	const counts = new Map<string, number>();
	for (const repo of repos) {
		const owner = repo.split("/")[0];
		if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
	}
	let best: string | null = null;
	for (const [owner, n] of counts) if (!best || n > (counts.get(best) ?? 0)) best = owner;
	return best;
}

/**
 * What a paste into the token field looks like, before Connect: a whole token by
 * its kind and last four, or a nudge when the paste came out short. Null when empty.
 */
export function pastedTokenLabel(input: string): string | null {
	if (!input.trim()) return null;
	const token = cleanGithubToken(input);
	return token
		? `Pasted ${credentialKindLabel(githubCredentialKind(token))} ending ${token.slice(-4)}`
		: "Not a whole GitHub token yet: it starts with github_pat_";
}

/**
 * What to do about a repository a fine-grained token can't push to. A token covers
 * one account or organization, so adding a repository works only for that owner's.
 */
export const FINE_GRAINED_REPO_HINT =
	"A fine-grained token covers one account or organization. Add a repository to it on GitHub if it belongs to that owner, with Contents set to read and write. A repository of another owner needs a token of its own, on another box. A token for an organization may also wait on an owner's approval.";

/**
 * The per-repository verdicts are for the token git sends, so when another credential
 * helper (a provider's) signs git in, they say nothing about the token gh holds.
 */
export const OTHER_HELPER_REPO_HINT =
	"git on this box signs in with another credential helper's token, so these results are for that token, not the one gh uses. To have git use this box's own token, disconnect that helper at your provider, then connect the token again.";

/** The same, when the warning above the list already explains the other helper. */
export const OTHER_HELPER_REPO_NOTE =
	"These results are for that helper's token, not the one gh uses.";

/** What to say under the per-repository verdicts when some can't push, if anything. */
export function repoVerdictHint(
	a: GithubAccessDTO,
	checks: readonly RepoAccessDTO[],
): string | null {
	if (!checks.some((c) => c.access === "none" || c.access === "read")) return null;
	if (a.git === "other") {
		// Said once: the short note when the warning above already explains the helper.
		const helper = otherHelperWarning(a);
		return helper && githubAccessProblem(a) === helper
			? OTHER_HELPER_REPO_NOTE
			: OTHER_HELPER_REPO_HINT;
	}
	return a.gh?.kind === "fine-grained" ? FINE_GRAINED_REPO_HINT : null;
}

/**
 * What still holds after a broad token is replaced: the box forgets it, GitHub
 * doesn't. Null unless the box's gh token is a broad one.
 */
export function broadTokenRevokeNote(a: GithubAccessDTO): string | null {
	if (!a.gh || !isBroadCredential(a.gh.kind)) return null;
	return a.gh.kind === "oauth"
		? "A new token replaces this one on the box, but GitHub keeps accepting the old one until you revoke GitHub CLI under Settings → Applications on GitHub. That also signs gh out on your other machines."
		: "A new token replaces this one on the box, but GitHub keeps accepting the old one until you delete it under Settings → Developer settings → Personal access tokens (classic).";
}

/** "expires in 12 days" or "expired 3 days ago". */
function expiryPhrase(expiresAt: number, now: number): string {
	const days = Math.round((expiresAt - now) / 86_400_000);
	if (days > 1) return `expires in ${days} days`;
	if (days === 1) return "expires tomorrow";
	if (days === 0) return expiresAt >= now ? "expires today" : "expired today";
	return `expired ${-days} day${days === -1 ? "" : "s"} ago`;
}

/**
 * What Ateam does on a box, and nothing else: the fine-grained permissions it asks
 * for. Commit statuses is read-only and there for the merge queue, which holds a
 * merge until CI passes: CI that reports commit statuses (rather than GitHub
 * Actions' check runs) is hidden on a private repository without it.
 */
export const FINE_GRAINED_PERMISSIONS = {
	contents: "write",
	pull_requests: "write",
	issues: "write",
	statuses: "read",
	metadata: "read",
} as const;

/**
 * GitHub's "new fine-grained token" page with everything Ateam can fill in: a name
 * naming the box and the day, 90 days, the owner the box's repositories belong to,
 * and only the permissions Ateam uses. Workflows stays off: an agent that can edit
 * `.github/workflows` can reach the repository's Actions secrets. GitHub has no
 * parameter for the repository list, so the user still picks those on the page.
 */
export function fineGrainedTokenUrl(opts: {
	box: string;
	owner?: string | null;
	now?: Date;
}): string {
	const day = (opts.now ?? new Date()).toISOString().slice(0, 10);
	// GitHub caps the name at 40 characters and wants it unique per account: the
	// date keeps a renewal from colliding with the token it replaces.
	const prefix = "Ateam ";
	const box = opts.box.slice(0, 40 - prefix.length - day.length - 1);
	const params = new URLSearchParams({
		name: `${prefix}${box} ${day}`,
		description: `Used by Ateam's agents on ${opts.box}. Give it only the repositories that box works on.`,
		expires_in: "90",
	});
	if (opts.owner) params.set("target_name", opts.owner);
	for (const [permission, level] of Object.entries(FINE_GRAINED_PERMISSIONS)) {
		params.set(permission, level);
	}
	return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`;
}

/**
 * A pasted token, trimmed, if it is shaped like one GitHub issues; null otherwise.
 * Catches the usual paste slips (the token's name, a stray space inside) before
 * the box asks GitHub.
 */
export function cleanGithubToken(input: string): string | null {
	const token = input.trim();
	return /^(github_pat_[A-Za-z0-9_]{20,}|gh[pous]_[A-Za-z0-9]{20,})$/.test(token) ? token : null;
}

/** `owner/name` from a github.com clone URL (https or ssh), or null for any other host. */
export function githubRepoFromUrl(url: string): string | null {
	const m = url
		.trim()
		.match(
			/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
		);
	return m ? `${m[1]}/${m[2]}` : null;
}

/** A token's kind, from its prefix. */
export function githubCredentialKind(token: string): GithubCredentialKind {
	if (token.startsWith("github_pat_")) return "fine-grained";
	if (token.startsWith("ghu_") || token.startsWith("ghs_")) return "app";
	if (token.startsWith("gho_")) return "oauth";
	if (token.startsWith("ghp_")) return "classic";
	return "unknown";
}
