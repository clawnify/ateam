import { describe, expect, it } from "bun:test";
import { generateTaskTags, MAX_TAGS, parseTagReply, sanitizeTags } from "../src/tagging";

/** A stubbed CLI: whatever the model "replied". */
const replying = (out: string) => () => Promise.resolve(out);

describe("parseTagReply", () => {
	it("reads a bare array", () => {
		expect(parseTagReply('["bug","api"]')).toEqual(["bug", "api"]);
	});

	it("survives a code fence, which models add unprompted", () => {
		expect(parseTagReply('```json\n["bug"]\n```')).toEqual(["bug"]);
	});

	it("survives a preamble sentence", () => {
		expect(parseTagReply('Here are the tags: ["ui","perf"]')).toEqual(["ui", "perf"]);
	});

	it("returns null on prose with no array", () => {
		expect(parseTagReply("I could not determine any tags.")).toBeNull();
	});

	it("returns null on malformed JSON rather than throwing", () => {
		expect(parseTagReply('["bug",')).toBeNull();
	});
});

describe("sanitizeTags", () => {
	it("lowercases and keeps in-vocabulary tags", () => {
		expect(sanitizeTags(["Bug", "API"])).toEqual(["bug", "api"]);
	});

	it("drops a sentence the model returned instead of a tag", () => {
		expect(sanitizeTags(["bug", "this task is about fixing the login flow"])).toEqual(["bug"]);
	});

	it("drops non-strings and duplicates", () => {
		expect(sanitizeTags(["bug", 7, "bug", null])).toEqual(["bug"]);
	});

	it("caps the count", () => {
		expect(sanitizeTags(["bug", "api", "ui", "db", "perf"]).length).toBe(MAX_TAGS);
	});

	it("accepts a project's own existing tags as vocabulary", () => {
		expect(sanitizeTags(["mobile"], ["mobile"])).toEqual(["mobile"]);
	});

	// Drift control: one newcomer is allowed so a genuinely new topic can appear,
	// but it cannot arrive alongside known tags and multiply into synonyms.
	it("allows at most one newcomer, and never trailing known tags", () => {
		expect(sanitizeTags(["frontend"])).toEqual(["frontend"]);
		expect(sanitizeTags(["bug", "frontend"])).toEqual(["bug"]);
	});

	it("returns empty for a non-array", () => {
		expect(sanitizeTags("bug")).toEqual([]);
		expect(sanitizeTags(null)).toEqual([]);
	});
});

describe("generateTaskTags", () => {
	it("returns the model's tags on a clean reply", async () => {
		expect(await generateTaskTags("fix login", { run: replying('["bug","auth"]') })).toEqual([
			"bug",
			"auth",
		]);
	});

	// Every failure below must collapse to null so the caller keeps its keyword
	// fallback. Tagging is decoration and may never break task creation.
	it("returns null when the model declines to label", async () => {
		expect(await generateTaskTags("hmm", { run: replying("[]") })).toBeNull();
	});

	it("returns null when the CLI is missing or errors", async () => {
		const run = () => Promise.reject(new Error("spawn claude ENOENT"));
		expect(await generateTaskTags("fix login", { run })).toBeNull();
	});

	it("returns null on unparseable output", async () => {
		expect(await generateTaskTags("fix login", { run: replying("no idea") })).toBeNull();
	});

	it("returns null for an empty prompt without calling the model", async () => {
		let called = false;
		const run = () => {
			called = true;
			return Promise.resolve('["bug"]');
		};
		expect(await generateTaskTags("   ", { run })).toBeNull();
		expect(called).toBe(false);
	});

	it("offers the project's existing tags to the model", async () => {
		let seen = "";
		const run = (input: string) => {
			seen = input;
			return Promise.resolve('["mobile"]');
		};
		expect(await generateTaskTags("ios build", { knownTags: ["mobile"], run })).toEqual(["mobile"]);
		expect(seen).toContain("mobile");
	});
});
