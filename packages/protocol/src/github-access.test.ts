import { describe, expect, it } from "bun:test";
import {
	broadTokenRevokeNote,
	cleanGithubToken,
	FINE_GRAINED_REPO_HINT,
	fineGrainedTokenUrl,
	type GithubAccessDTO,
	githubAccessProblem,
	githubAccessSummary,
	githubAccessUrgent,
	githubCredentialKind,
	githubHelperWarning,
	githubRepoFromUrl,
	githubTokenNeedsRenewal,
	githubTokenWouldHelp,
	mostCommonOwner,
	OTHER_HELPER_REPO_HINT,
	OTHER_HELPER_REPO_NOTE,
	pastedTokenLabel,
	repoVerdictHint,
	tokenBoxName,
	tokenOwnerChoices,
	tokenOwnerNote,
} from "./github-access";

const fine = {
	kind: "fine-grained" as const,
	hint: "wxyz",
	login: "octo",
	rejected: false,
	expiresAt: null,
	source: "store" as const,
};
const base: GithubAccessDTO = {
	ghInstalled: true,
	gh: fine,
	git: "gh",
	gitCredential: null,
	unverified: null,
};

describe("fineGrainedTokenUrl", () => {
	it("fills in a dated name, the owner, 90 days and only Ateam's permissions", () => {
		const url = new URL(
			fineGrainedTokenUrl({
				box: "ateam-probe",
				owner: "acme",
				now: new Date("2026-11-02T12:00:00Z"),
			}),
		);
		expect(url.origin + url.pathname).toBe(
			"https://github.com/settings/personal-access-tokens/new",
		);
		const p = url.searchParams;
		expect(p.get("name")).toBe("Ateam ateam-probe 2026-11-02");
		expect(p.get("target_name")).toBe("acme");
		expect(p.get("expires_in")).toBe("90");
		expect(p.get("contents")).toBe("write");
		expect(p.get("pull_requests")).toBe("write");
		expect(p.get("issues")).toBe("write");
		expect(p.get("metadata")).toBe("read");
		expect(p.get("statuses")).toBe("read");
		expect(p.has("workflows")).toBe(false);
		expect(p.has("administration")).toBe(false);
	});

	it("keeps the name within GitHub's 40 characters and leaves the owner out when unknown", () => {
		const url = new URL(fineGrainedTokenUrl({ box: "x".repeat(80), now: new Date("2026-11-02") }));
		expect(url.searchParams.get("name")?.length).toBeLessThanOrEqual(40);
		expect(url.searchParams.has("target_name")).toBe(false);
	});
});

describe("cleanGithubToken", () => {
	it("trims a pasted token and refuses what isn't one", () => {
		const pat = `github_pat_${"a".repeat(70)}`;
		expect(cleanGithubToken(`  ${pat}\n`)).toBe(pat);
		expect(cleanGithubToken(`ghp_${"Z".repeat(36)}`)).toBe(`ghp_${"Z".repeat(36)}`);
		expect(cleanGithubToken("ateam box")).toBeNull();
		expect(cleanGithubToken(`github_pat_${"a".repeat(10)} ${"a".repeat(20)}`)).toBeNull();
		expect(cleanGithubToken(`ghr_${"a".repeat(36)}`)).toBeNull();
	});
});

describe("repoVerdictHint", () => {
	const none = [{ repo: "acme/app", access: "none" as const }];
	it("says nothing when every repository can push", () => {
		expect(repoVerdictHint(base, [{ repo: "acme/app", access: "push" }])).toBeNull();
	});
	it("points at the token's repository list when git uses the fine-grained token", () => {
		expect(repoVerdictHint(base, none)).toBe(FINE_GRAINED_REPO_HINT);
	});
	it("says the results are another helper's when a provider signs git in", () => {
		expect(repoVerdictHint({ ...base, git: "other" }, none)).toBe(OTHER_HELPER_REPO_HINT);
	});
	it("says it briefly when the warning above already explains a provider's broad helper", () => {
		const broad = {
			...base,
			git: "other" as const,
			gitCredential: {
				kind: "oauth" as const,
				hint: "9876",
				login: "o",
				rejected: false,
				expiresAt: null,
			},
		};
		expect(githubAccessProblem(broad)).toContain("9876");
		expect(githubHelperWarning(broad)).toBeNull();
		expect(repoVerdictHint(broad, none)).toBe(OTHER_HELPER_REPO_NOTE);
	});
});

describe("broadTokenRevokeNote", () => {
	it("tells what replacing a broad token leaves behind, and says nothing for a scoped one", () => {
		expect(broadTokenRevokeNote(base)).toBeNull();
		expect(broadTokenRevokeNote({ ...base, gh: { ...fine, kind: "oauth" } })).toContain(
			"other machines",
		);
		expect(broadTokenRevokeNote({ ...base, gh: { ...fine, kind: "classic" } })).toContain(
			"(classic)",
		);
	});
});

describe("githubTokenWouldHelp", () => {
	it("opens the form when a token fixes things, and not when the fix is elsewhere", () => {
		expect(githubTokenWouldHelp(base)).toBe(false);
		expect(githubTokenWouldHelp({ ...base, gh: null, git: "none" })).toBe(true);
		expect(githubTokenWouldHelp({ ...base, gh: { ...fine, rejected: true } })).toBe(true);
		expect(githubTokenWouldHelp({ ...base, gh: { ...fine, kind: "classic" } })).toBe(true);
		expect(githubTokenWouldHelp({ ...base, git: "none" })).toBe(true);
		expect(githubTokenWouldHelp({ ...base, ghInstalled: false, gh: null })).toBe(false);
		expect(githubTokenWouldHelp({ ...base, gh: { ...fine, kind: "oauth", source: "env" } })).toBe(
			false,
		);
	});
});

describe("mostCommonOwner", () => {
	it("picks the owner most repositories share", () => {
		expect(mostCommonOwner(["acme/a", "me/b", "acme/c"])).toBe("acme");
		expect(mostCommonOwner([])).toBeNull();
	});
});

describe("pastedTokenLabel", () => {
	it("says what landed, so a partial paste shows before Connect", () => {
		expect(pastedTokenLabel("")).toBeNull();
		expect(pastedTokenLabel(`github_pat_${"a".repeat(60)}wxyz`)).toBe(
			"Pasted a fine-grained token ending wxyz",
		);
		expect(pastedTokenLabel("github_pat_123")).toContain("Not a whole GitHub token");
	});
});

describe("githubRepoFromUrl", () => {
	it("reads owner/name from https and ssh URLs, and nothing from other hosts", () => {
		expect(githubRepoFromUrl("https://github.com/acme/app.git")).toBe("acme/app");
		expect(githubRepoFromUrl("https://github.com/acme/app")).toBe("acme/app");
		expect(githubRepoFromUrl("https://x-access-token@github.com/acme/my.repo.git")).toBe(
			"acme/my.repo",
		);
		expect(githubRepoFromUrl("git@github.com:acme/app.git")).toBe("acme/app");
		expect(githubRepoFromUrl("ssh://git@github.com/acme/app.git")).toBe("acme/app");
		expect(githubRepoFromUrl("https://gitlab.com/acme/app.git")).toBeNull();
		expect(githubRepoFromUrl("https://github.com/acme")).toBeNull();
	});
});

describe("githubCredentialKind", () => {
	it("reads the kind from the prefix", () => {
		expect(githubCredentialKind("github_pat_x")).toBe("fine-grained");
		expect(githubCredentialKind("ghu_x")).toBe("app");
		expect(githubCredentialKind("gho_x")).toBe("oauth");
		expect(githubCredentialKind("ghp_x")).toBe("classic");
		expect(githubCredentialKind("x")).toBe("unknown");
	});
});

describe("githubAccessProblem", () => {
	it("says nothing when gh and git share a scoped token", () => {
		expect(githubAccessProblem(base)).toBeNull();
	});

	it("puts a refused token before anything else", () => {
		expect(
			githubAccessProblem({ ...base, gh: { ...fine, rejected: true }, git: "none" }),
		).toContain("refused");
	});

	it("asks to connect when nothing signs in", () => {
		expect(githubAccessProblem({ ...base, gh: null, git: "none" })).toContain("Connect GitHub");
	});

	it("warns about a broad token", () => {
		expect(githubAccessProblem({ ...base, gh: { ...fine, kind: "oauth" } })).toContain(
			"every repository",
		);
	});

	it("says pushing fails when git can't sign in", () => {
		expect(githubAccessProblem({ ...base, git: "none" })).toContain("pushing fails");
	});

	it("names a provider's broad git token even when gh's is scoped", () => {
		const problem = githubAccessProblem({
			...base,
			git: "other",
			gitCredential: {
				kind: "oauth",
				hint: "9876",
				login: "octo",
				rejected: false,
				expiresAt: null,
			},
		});
		expect(problem).toContain("9876");
		expect(problem).toContain("provider");
	});
});

describe("token expiry", () => {
	const now = Date.parse("2026-11-02T00:00:00Z");
	const day = 86_400_000;
	const expiring = (days: number) => ({ ...base, gh: { ...fine, expiresAt: now + days * day } });

	it("warns, and opens the form, when the token has under two weeks left", () => {
		expect(githubAccessProblem(expiring(5), now)).toBe(
			"This box's token expires in 5 days. Connect a new one before then, or tasks here can't push or open pull requests.",
		);
		expect(githubTokenWouldHelp(expiring(5), now)).toBe(true);
		expect(githubAccessUrgent(expiring(5), now)).toBe(false);
	});

	it("says nothing while the token has a while to go", () => {
		expect(githubAccessProblem(expiring(40), now)).toBeNull();
		expect(githubTokenWouldHelp(expiring(40), now)).toBe(false);
	});

	it("says what already stopped once the token has expired", () => {
		expect(githubAccessProblem(expiring(-3), now)).toBe(
			"This box's token expired 3 days ago, so tasks here can't push or open pull requests. Connect a new one.",
		);
	});

	it("names only pull requests when another helper signs git in", () => {
		expect(githubAccessProblem({ ...expiring(5), git: "other" }, now)).toBe(
			"This box's token expires in 5 days. Connect a new one before then, or Ateam can't open pull requests or merge from this box.",
		);
	});

	it("keeps a provider helper's full-access token in view under the expiry warning", () => {
		const helper = {
			...expiring(5),
			git: "other" as const,
			gitCredential: {
				kind: "oauth" as const,
				hint: "9876",
				login: "o",
				rejected: false,
				expiresAt: null,
			},
		};
		expect(githubAccessProblem(helper, now)).toContain("expires in 5 days");
		expect(githubHelperWarning(helper, now)).toContain("full-access token ending 9876");
		expect(repoVerdictHint(helper, [{ repo: "acme/app", access: "read" }])).toBe(
			OTHER_HELPER_REPO_NOTE,
		);
	});

	it("sends a GH_TOKEN that's expiring back to where it's set", () => {
		const env = { ...base, gh: { ...fine, source: "env" as const, expiresAt: now + 5 * day } };
		expect(githubAccessProblem(env, now)).toBe(
			"The token in GH_TOKEN, set in the engine's environment, expires in 5 days. Replace it there: a token connected from Ateam would be ignored.",
		);
		expect(githubTokenWouldHelp(env, now)).toBe(false);
	});

	it("wants renewing in its last two weeks, once expired, and once refused", () => {
		expect(githubTokenNeedsRenewal(expiring(5), now)).toBe(true);
		expect(githubTokenNeedsRenewal(expiring(-1), now)).toBe(true);
		expect(githubTokenNeedsRenewal(expiring(40), now)).toBe(false);
		expect(githubTokenNeedsRenewal({ ...base, gh: { ...fine, rejected: true } }, now)).toBe(true);
		expect(githubTokenNeedsRenewal({ ...base, gh: null }, now)).toBe(false);
	});

	it("is urgent once the token has expired or GitHub refuses it", () => {
		expect(githubAccessUrgent(expiring(-1), now)).toBe(true);
		expect(githubAccessUrgent({ ...base, gh: { ...fine, rejected: true } }, now)).toBe(true);
		expect(githubAccessUrgent(base, now)).toBe(false);
	});
});

describe("githubAccessSummary", () => {
	it("says who, with what, and when it expires", () => {
		const now = Date.parse("2026-11-02T00:00:00Z");
		expect(
			githubAccessSummary({ ...base, gh: { ...fine, expiresAt: now + 12 * 86_400_000 } }, now),
		).toBe("Signed in as octo with a fine-grained token ending wxyz, expires in 12 days");
		expect(githubAccessSummary({ ...base, gh: null, git: "none" })).toBe("Not connected to GitHub");
	});
});

describe("tokenOwnerChoices", () => {
	it("guesses the owner most of the box's repositories belong to", () => {
		const c = tokenOwnerChoices({
			boxRepos: ["acme/app", "acme/api", "octo/dots"],
			personal: "octo",
			seen: ["zeta", "acme"],
		});
		expect(c).toEqual({ guess: "acme", options: ["acme", "octo", "zeta"] });
	});

	it("falls back to the personal account, then to none", () => {
		expect(tokenOwnerChoices({ boxRepos: [], personal: "octo" }).guess).toBe("octo");
		expect(tokenOwnerChoices({ boxRepos: [], personal: null })).toEqual({
			guess: null,
			options: [],
		});
	});
});

describe("tokenOwnerNote", () => {
	it("says whose account a token for a box without projects is for", () => {
		expect(tokenOwnerNote({ boxRepos: [], owner: "octo", personal: "octo" })).toBe(
			"This box has no projects yet, so the token is for your personal account (octo). Pick an organization if this box will work on its repositories.",
		);
		expect(tokenOwnerNote({ boxRepos: [], owner: null, personal: null })).toContain(
			"the account signed in to GitHub",
		);
	});

	it("says nothing once an organization is picked", () => {
		expect(tokenOwnerNote({ boxRepos: [], owner: "acme", personal: "octo" })).toBeNull();
	});

	it("names the repositories another owner's token can't push to", () => {
		expect(
			tokenOwnerNote({
				boxRepos: ["acme/app", "octo/a", "octo/b", "octo/c", "Acme/api"],
				owner: "acme",
				personal: "octo",
			}),
		).toBe(
			"This token reaches acme's repositories only, so the box can't push to octo/a, octo/b and 1 more.",
		);
		expect(tokenOwnerNote({ boxRepos: ["acme/app"], owner: "acme", personal: "octo" })).toBeNull();
	});
});

describe("tokenBoxName", () => {
	it("prefers the box's hostname over an address", () => {
		expect(tokenBoxName("100.120.81.58:8787", "ateam-verify")).toBe("ateam-verify");
		expect(tokenBoxName("100.120.81.58", "ateam-verify")).toBe("ateam-verify");
		expect(tokenBoxName("box.tail1234.ts.net:8787", "box")).toBe("box");
		expect(tokenBoxName("[fd7a:115c::1]", "box")).toBe("box");
	});

	it("keeps a real name, and an address when no hostname is known", () => {
		expect(tokenBoxName("ateam-probe.boxd", "ip-10-0-0-1")).toBe("ateam-probe.boxd");
		expect(tokenBoxName("my-sprite", "sprite-host")).toBe("my-sprite");
		expect(tokenBoxName("dead.beef", "host")).toBe("dead.beef");
		expect(tokenBoxName("cafe", "host")).toBe("cafe");
		expect(tokenBoxName("100.120.81.58:8787", undefined)).toBe("100.120.81.58:8787");
	});
});
