import { expect, test } from "bun:test";
import { NO_GITHUB_SEEN, parseGithubSeen, rememberGithubSeen, sameGithubSeen } from "./github-seen";

test("keeps what boxes showed, newest first, once each whatever the case", () => {
	const a = rememberGithubSeen(NO_GITHUB_SEEN, "octo", ["acme", "octo"]);
	const b = rememberGithubSeen(a, "Octo", ["zeta", "ACME"]);
	expect(b).toEqual({ logins: ["Octo"], owners: ["zeta", "ACME", "octo"] });
});

test("says when a fold changed nothing, so it isn't written back", () => {
	const a = rememberGithubSeen(NO_GITHUB_SEEN, "octo", ["acme"]);
	expect(sameGithubSeen(a, rememberGithubSeen(a, "octo", ["acme"]))).toBe(true);
	expect(sameGithubSeen(a, rememberGithubSeen(a, null, ["zeta"]))).toBe(false);
});

test("reads anything malformed as nothing seen", () => {
	expect(parseGithubSeen(null)).toEqual(NO_GITHUB_SEEN);
	expect(parseGithubSeen("not json")).toEqual(NO_GITHUB_SEEN);
	expect(parseGithubSeen('{"logins":["octo",3,""],"owners":"acme"}')).toEqual({
		logins: ["octo"],
		owners: [],
	});
});
