import { describe, expect, it } from "bun:test";
import {
	checkRepoAccess,
	connectGithubToken,
	type GithubAccessDeps,
	githubAccessStatus,
	parseTokenExpiry,
	type Run,
} from "../src/github-access";

const PAT = `github_pat_${"A".repeat(60)}wxyz`;
const OAUTH = `gho_${"B".repeat(32)}9876`;

interface Call {
	cmd: string;
	args: string[];
	input?: string;
}

/**
 * A stand-in machine: `gh` and `git` answer from `programs`, GitHub from `github`.
 * Every call is recorded, so a test can prove where the token went.
 */
function machine(opts: {
	ghToken?: string | null;
	ghMissing?: boolean;
	gitToken?: string | null;
	systemHelper?: boolean;
	gitName?: string;
	ghLoginFails?: string;
	gitEmail?: string;
	env?: NodeJS.ProcessEnv;
	users?: Record<string, { status: number; login?: string; expiry?: string }>;
	discovery?: Record<string, number>;
	offline?: boolean;
}) {
	const calls: Call[] = [];
	const fetches: { url: string; authorization: string | null }[] = [];
	let ghToken = opts.ghToken ?? null;
	const run: Run = async (cmd, args, o) => {
		calls.push({ cmd, args, input: o?.input });
		const line = `${cmd} ${args.join(" ")}`;
		if (cmd === "gh" && opts.ghMissing) {
			throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
		}
		if (line === "gh auth token --hostname github.com") {
			if (!ghToken) throw new Error("no oauth token found for github.com");
			return { stdout: `${ghToken}\n`, stderr: "" };
		}
		if (line === "gh auth login --hostname github.com --with-token") {
			if (opts.ghLoginFails) throw new Error(opts.ghLoginFails);
			ghToken = (o?.input ?? "").trim();
			return { stdout: "", stderr: "" };
		}
		if (line === "gh auth setup-git --hostname github.com") return { stdout: "", stderr: "" };
		if (line.startsWith("git -c credential.interactive=never credential fill")) {
			const token = opts.gitToken === undefined ? ghToken : opts.gitToken;
			if (!token) throw new Error("fatal: could not read Username: terminal prompts disabled");
			return {
				stdout: `protocol=https\nhost=github.com\nusername=someone\npassword=${token}\n`,
				stderr: "",
			};
		}
		if (line.startsWith("git config --system --get-regexp")) {
			if (!opts.systemHelper) throw new Error("");
			return { stdout: "credential.helper boxd\n", stderr: "" };
		}
		if (line === "git config --global --get user.name") {
			if (!opts.gitName) throw new Error("");
			return { stdout: `${opts.gitName}\n`, stderr: "" };
		}
		if (line === "git config --global --get user.email") {
			if (!opts.gitEmail) throw new Error("");
			return { stdout: `${opts.gitEmail}\n`, stderr: "" };
		}
		if (line.startsWith("git config --global user.")) return { stdout: "", stderr: "" };
		throw new Error(`unexpected command: ${line}`);
	};
	const fetchImpl: GithubAccessDeps["fetch"] = async (url, init) => {
		const headers = new Headers(init?.headers);
		const authorization = headers.get("authorization");
		fetches.push({ url, authorization });
		if (opts.offline) throw new Error("getaddrinfo ENOTFOUND api.github.com");
		if (url === "https://api.github.com/user") {
			const token = authorization?.replace(/^Bearer /, "") ?? "";
			const user = opts.users?.[token] ?? { status: 401 };
			const responseHeaders = new Headers();
			if (user.expiry) responseHeaders.set("github-authentication-token-expiration", user.expiry);
			return new Response(
				user.status === 200 ? JSON.stringify({ login: user.login, id: 42, name: null }) : "{}",
				{ status: user.status, headers: responseHeaders },
			);
		}
		const status = opts.discovery?.[url];
		if (status === undefined) throw new Error(`unexpected fetch: ${url}`);
		return new Response("", { status });
	};
	const deps: GithubAccessDeps = { run, fetch: fetchImpl, env: opts.env ?? {} };
	return { deps, calls, fetches };
}

describe("githubAccessStatus", () => {
	it("names the box by its hostname, for its token's name", async () => {
		const { deps } = machine({ ghMissing: true, gitToken: null });
		expect((await githubAccessStatus(deps)).hostname).toBeUndefined();
		const named = await githubAccessStatus({ ...deps, hostname: () => "ateam-verify" });
		expect(named.hostname).toBe("ateam-verify");
	});

	it("says gh is missing when the box has no gh", async () => {
		const { deps } = machine({ ghMissing: true, gitToken: null });
		const s = await githubAccessStatus(deps);
		expect(s.ghInstalled).toBe(false);
		expect(s.gh).toBeNull();
		expect(s.git).toBe("none");
	});

	it("reads a fine-grained token gh and git share, with GitHub's login and expiry, never the token", async () => {
		const { deps } = machine({
			ghToken: PAT,
			users: { [PAT]: { status: 200, login: "octo", expiry: "2026-12-01 10:00:00 UTC" } },
		});
		const s = await githubAccessStatus(deps);
		expect(s).toEqual({
			ghInstalled: true,
			gh: {
				kind: "fine-grained",
				hint: "wxyz",
				login: "octo",
				rejected: false,
				expiresAt: Date.parse("2026-12-01T10:00:00Z"),
				source: "store",
			},
			git: "gh",
			gitCredential: null,
			unverified: null,
		});
		expect(JSON.stringify(s)).not.toContain(PAT);
	});

	it("reports a provider's helper signing git in with a different, broad token", async () => {
		const { deps } = machine({
			ghToken: PAT,
			gitToken: OAUTH,
			users: { [PAT]: { status: 200, login: "octo" }, [OAUTH]: { status: 200, login: "octo" } },
		});
		const s = await githubAccessStatus(deps);
		expect(s.git).toBe("other");
		expect(s.gitCredential).toMatchObject({ kind: "oauth", hint: "9876", login: "octo" });
	});

	it("flags a token GitHub refuses", async () => {
		const { deps } = machine({ ghToken: PAT, users: {} });
		const s = await githubAccessStatus(deps);
		expect(s.gh).toMatchObject({ rejected: true, login: null });
	});

	it("says so when GitHub can't be reached, rather than calling the token bad", async () => {
		const { deps } = machine({ ghToken: PAT, offline: true });
		const s = await githubAccessStatus(deps);
		expect(s.gh).toMatchObject({ rejected: false, login: null, kind: "fine-grained" });
		expect(s.unverified).toContain("Couldn't reach GitHub");
	});

	it("names a GH_TOKEN in the engine's environment as the source", async () => {
		const { deps } = machine({
			ghToken: PAT,
			env: { GH_TOKEN: PAT },
			users: { [PAT]: { status: 200, login: "octo" } },
		});
		expect((await githubAccessStatus(deps)).gh?.source).toBe("env");
	});
});

describe("connectGithubToken", () => {
	it("refuses something that isn't a token without calling GitHub", async () => {
		const { deps, fetches, calls } = machine({});
		await expect(connectGithubToken("ateam box token", deps)).rejects.toThrow(
			"doesn't look like a GitHub token",
		);
		expect(fetches).toHaveLength(0);
		expect(calls).toHaveLength(0);
	});

	it("refuses a token GitHub refuses, before gh ever sees it", async () => {
		const { deps, calls } = machine({ users: {} });
		await expect(connectGithubToken(PAT, deps)).rejects.toThrow("GitHub refused this token");
		expect(calls.some((c) => c.cmd === "gh")).toBe(false);
	});

	it("hands the token to gh on stdin only, sets git up, and fills in a missing identity", async () => {
		const { deps, calls } = machine({
			gitToken: undefined,
			users: { [PAT]: { status: 200, login: "octo" } },
		});
		const s = await connectGithubToken(`  ${PAT}\n`, deps);
		const login = calls.find((c) => c.args.includes("--with-token"));
		expect(login?.input).toBe(`${PAT}\n`);
		for (const c of calls) expect(c.args.join(" ")).not.toContain(PAT);
		expect(calls.some((c) => c.args.join(" ") === "auth setup-git --hostname github.com")).toBe(
			true,
		);
		expect(calls.map((c) => c.args.join(" "))).toContain("config --global user.name octo");
		expect(calls.map((c) => c.args.join(" "))).toContain(
			"config --global user.email 42+octo@users.noreply.github.com",
		);
		expect(s.gh).toMatchObject({ kind: "fine-grained", login: "octo" });
		expect(s.git).toBe("gh");
	});

	it("leaves an existing identity alone", async () => {
		const { deps, calls } = machine({
			gitName: "Someone Else",
			users: { [PAT]: { status: 200, login: "octo" } },
		});
		await connectGithubToken(PAT, deps);
		expect(calls.map((c) => c.args.join(" "))).not.toContain("config --global user.name octo");
	});

	it("replaces a box image's stand-in identity, which credits commits to no one", async () => {
		const { deps, calls } = machine({
			gitName: "Sprite",
			gitEmail: "noreply@sprites.dev",
			users: { [PAT]: { status: 200, login: "octo" } },
		});
		await connectGithubToken(PAT, deps);
		const set = calls.map((c) => c.args.join(" "));
		expect(set).toContain("config --global user.name octo");
		expect(set).toContain("config --global user.email 42+octo@users.noreply.github.com");
	});

	it("leaves a provider's system-wide git helper in charge of git", async () => {
		const { deps, calls } = machine({
			gitToken: OAUTH,
			systemHelper: true,
			users: { [PAT]: { status: 200, login: "octo" }, [OAUTH]: { status: 200, login: "octo" } },
		});
		const s = await connectGithubToken(PAT, deps);
		expect(calls.some((c) => c.args.join(" ").startsWith("auth setup-git"))).toBe(false);
		expect(s.git).toBe("other");
	});

	it("refuses when GH_TOKEN would override whatever gh stores", async () => {
		const { deps } = machine({
			env: { GH_TOKEN: "x" },
			users: { [PAT]: { status: 200, login: "o" } },
		});
		await expect(connectGithubToken(PAT, deps)).rejects.toThrow("GH_TOKEN");
	});

	it("says the box needs an update when gh is missing", async () => {
		const { deps } = machine({ ghMissing: true, users: { [PAT]: { status: 200, login: "o" } } });
		await expect(connectGithubToken(PAT, deps)).rejects.toThrow("no GitHub CLI");
	});
});

describe("checkRepoAccess", () => {
	const url = (repo: string, service: string) =>
		`https://github.com/${repo}.git/info/refs?service=${service}`;

	it("tells push, read only, invisible and unknown apart with git's own token", async () => {
		const { deps, fetches } = machine({
			gitToken: PAT,
			discovery: {
				[url("acme/app", "git-receive-pack")]: 200,
				[url("cli/cli", "git-receive-pack")]: 403,
				[url("cli/cli", "git-upload-pack")]: 200,
				[url("acme/secret", "git-receive-pack")]: 404,
				[url("acme/flaky", "git-receive-pack")]: 502,
			},
		});
		const out = await checkRepoAccess(
			["acme/app", "cli/cli", "acme/secret", "acme/flaky", "acme/app", "../etc", 7],
			deps,
		);
		expect(out).toEqual([
			{ repo: "acme/app", access: "push" },
			{ repo: "cli/cli", access: "read" },
			{ repo: "acme/secret", access: "none" },
			{ repo: "acme/flaky", access: "unknown" },
		]);
		const basic = `Basic ${Buffer.from(`x-access-token:${PAT}`).toString("base64")}`;
		expect(fetches.every((f) => f.authorization === basic)).toBe(true);
	});

	it("still tells a public repo apart with no token at all", async () => {
		const { deps, fetches } = machine({
			gitToken: null,
			ghToken: null,
			discovery: {
				[url("cli/cli", "git-receive-pack")]: 401,
				[url("cli/cli", "git-upload-pack")]: 200,
			},
		});
		expect(await checkRepoAccess(["cli/cli"], deps)).toEqual([{ repo: "cli/cli", access: "read" }]);
		expect(fetches.every((f) => f.authorization === null)).toBe(true);
	});
});

describe("parseTokenExpiry", () => {
	it("reads GitHub's formats and ignores anything else", () => {
		expect(parseTokenExpiry("2026-12-01 10:00:00 UTC")).toBe(Date.parse("2026-12-01T10:00:00Z"));
		expect(parseTokenExpiry("2026-12-01 10:00:00 -0700")).toBe(Date.parse("2026-12-01T17:00:00Z"));
		expect(parseTokenExpiry(null)).toBeNull();
		expect(parseTokenExpiry("soon")).toBeNull();
	});
});

describe("a token GitHub won't describe", () => {
	it("is handed to gh anyway, since gh judges it, and the identity is left alone", async () => {
		const { deps, calls } = machine({ users: { [PAT]: { status: 403 } } });
		const s = await connectGithubToken(PAT, deps);
		expect(calls.some((c) => c.args.includes("--with-token"))).toBe(true);
		expect(calls.some((c) => c.args.join(" ").startsWith("config --global user."))).toBe(false);
		expect(s.gh).toMatchObject({ kind: "fine-grained", login: null, rejected: false });
		expect(s.unverified).toContain("didn't say whose");
	});
});
