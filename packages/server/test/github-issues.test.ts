import { describe, expect, it } from "bun:test";
import type { GithubIssueDTO } from "@ateam/protocol";
import { GithubIssues, parseIssuePages, repositoryName } from "../src/github-issues";

const raw = (number: number) => ({
	number,
	title: `Issue ${number}`,
	body: null,
	user: { login: "author" },
	labels: [{ name: "bug" }],
});
const issue: GithubIssueDTO = {
	number: 1,
	title: "Issue",
	body: "",
	url: "https://github.com/acme/repo/issues/1",
	author: "author",
	labels: [],
};

describe("GitHub issues", () => {
	it("flattens all pages, excludes PRs, deduplicates and normalizes nullable descriptions", () => {
		const issues = parseIssuePages(
			[
				[raw(1), { ...raw(2), pull_request: {} }],
				[raw(1), raw(3)],
			],
			"acme/repo",
		);
		expect(issues.map((item) => item.number)).toEqual([1, 3]);
		expect(issues[0]).toMatchObject({
			body: "",
			labels: ["bug"],
			author: "author",
			url: "https://github.com/acme/repo/issues/1",
		});
		expect(() => parseIssuePages([[{ number: "bad" }]], "acme/repo")).toThrow();
	});
	it("rejects path traversal and arbitrary endpoints before fetching", async () => {
		let calls = 0;
		const sync = new GithubIssues(async () => {
			calls++;
			return [];
		});
		for (const name of [
			"../repo",
			"acme/..",
			"acme/repo/issues",
			"-X/POST",
			"acme/repo?state=all",
		]) {
			await expect(sync.list(name)).rejects.toThrow("Invalid GitHub repository");
		}
		expect(calls).toBe(0);
		expect(repositoryName("Acme/.github")).toBe("acme/.github");
	});
	it("coalesces windows, throttles polls, replaces closed issues and preserves last sync on failure", async () => {
		let now = 1000;
		let calls = 0;
		let fail = false;
		let rows = [issue];
		const sync = new GithubIssues(
			async () => {
				calls++;
				if (fail) throw new Error("offline");
				return rows;
			},
			() => now,
		);
		const [a, b] = await Promise.all([sync.list("Acme/repo"), sync.list("acme/repo")]);
		expect(a).toEqual(b);
		expect(calls).toBe(1);
		await sync.list("acme/repo");
		expect(calls).toBe(1);
		fail = true;
		now += 60_000;
		const offline = await sync.list("acme/repo");
		expect(offline.issues).toEqual([issue]);
		expect(offline.syncedAt).toBe(1000);
		expect(offline.error).toContain("Could not sync");
		await sync.list("acme/repo");
		expect(calls).toBe(2);
		fail = false;
		rows = [];
		const refreshed = await sync.list("acme/repo", true);
		expect(refreshed).toEqual({ issues: [], syncedAt: now, error: null });
		expect(calls).toBe(3);
	});
	it("does not reuse another repository's cache after an access failure", async () => {
		const sync = new GithubIssues(async (name) => {
			if (name === "acme/private") throw new Error("HTTP 403");
			return [issue];
		});
		await sync.list("acme/repo");
		const result = await sync.list("acme/private");
		expect(result.issues).toEqual([]);
		expect(result.syncedAt).toBeNull();
		expect(result.error).toContain("access failed");
	});
});
