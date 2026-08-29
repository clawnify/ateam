import { expect, test } from "bun:test";
import { Bug, GitBranch, Rocket } from "lucide-react";
import { MAX_TAGS, matchesTagQuery, TAG_RULES, tagsFor, taskIcon, taskTags } from "./task-tags";

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
	const t = { name: "fix the auth api" };
	expect(matchesTagQuery("#bug", t)).toBe(true);
	expect(matchesTagQuery("#a", t)).toBe(true); // prefix: auth + api
	expect(matchesTagQuery("#auth", t)).toBe(true);
	expect(matchesTagQuery("#release", t)).toBe(false);
});

test("a bare # matches everything, so typing it does not blank the board", () => {
	expect(matchesTagQuery("#", { name: "anything at all" })).toBe(true);
});

test("#tag search reads the description too", () => {
	expect(
		matchesTagQuery("#release", {
			name: "users have to multitask",
			description: "we should deploy this",
		}),
	).toBe(true);
});

test("model tags win over the keyword reading of the same task", () => {
	// Keywords would say "bug" here; the model looked at intent and said "perf".
	const t = { name: "fix the slow board", tags: ["perf"] };
	expect(tagsFor(t)).toEqual(["perf"]);
	expect(matchesTagQuery("#perf", t)).toBe(true);
	expect(matchesTagQuery("#bug", t)).toBe(false);
});

test("keywords carry a task the model never tagged", () => {
	expect(tagsFor({ name: "fix the auth api", tags: null })).toEqual(["bug", "auth", "api"]);
	expect(tagsFor({ name: "fix the auth api", tags: [] })).toEqual(["bug", "auth", "api"]);
});

test("model tags are capped like keyword ones", () => {
	const t = { name: "whatever", tags: ["a", "b", "c", "d", "e"] };
	expect(tagsFor(t).length).toBe(MAX_TAGS);
});
