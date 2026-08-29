import { expect, test } from "bun:test";
import { Bug, GitBranch, Rocket } from "lucide-react";
import { MAX_TAGS, matchesTagQuery, TAG_RULES, taskIcon, taskTags } from "./task-tags";

test("a task carries every category its text matches, not just the first", () => {
	expect(taskTags("fix the auth api")).toEqual(["bug", "auth", "api"]);
});

test("an untagged task gets no chips rather than a fallback tag", () => {
	expect(taskTags("thinking about next quarter")).toEqual([]);
});

test("tags are capped so chips stay a glance", () => {
	// bug + docs + auth + ui + test would be five without the cap.
	const t = taskTags("fix the docs for auth ui tests");
	expect(t.length).toBe(MAX_TAGS);
	expect(t).toEqual(["bug", "docs", "auth"]);
});

test("the description contributes, since the name is often a truncated prompt", () => {
	expect(taskTags("users have to multitask")).toEqual([]);
	expect(taskTags("users have to multitask", "we should deploy this")).toEqual(["release"]);
});

test("matching is word-bounded, so 'apirate' is not an api task", () => {
	expect(taskTags("apirate behaviour")).toEqual([]);
	expect(taskTags("the api rate limit")).toContain("api");
});

test("the icon still comes from the first match, unchanged", () => {
	expect(taskIcon("fix the auth api")).toBe(Bug);
	expect(taskIcon("ship the release")).toBe(Rocket);
	expect(taskIcon("thinking about next quarter")).toBe(GitBranch);
});

test("the icon is exactly the first tag's icon — one rule set, two readings", () => {
	for (const name of ["deploy the new database schema", "fix the auth api", "update the readme"]) {
		const first = taskTags(name)[0];
		const rule = TAG_RULES.find((r) => r.tag === first);
		expect(rule).toBeDefined();
		expect(taskIcon(name)).toBe(rule!.icon);
	}
});

test("#tag search narrows as you type and matches any of a task's tags", () => {
	const name = "fix the auth api";
	expect(matchesTagQuery("#bug", name)).toBe(true);
	expect(matchesTagQuery("#a", name)).toBe(true); // prefix: auth + api
	expect(matchesTagQuery("#auth", name)).toBe(true);
	expect(matchesTagQuery("#release", name)).toBe(false);
});

test("a bare # matches everything, so typing it does not blank the board", () => {
	expect(matchesTagQuery("#", "anything at all")).toBe(true);
});

test("#tag search reads the description too", () => {
	expect(matchesTagQuery("#release", "users have to multitask", "we should deploy this")).toBe(
		true,
	);
});
