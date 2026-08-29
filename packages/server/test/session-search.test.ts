import { describe, expect, test } from "bun:test";
import { cleanPrompt, contentText, pushPrompt } from "../src/session-search/digest";
import { rank, terms } from "../src/session-search/rank";
import { extractJson, parseVerdicts } from "../src/session-search/rerank";
import type { SessionDigest } from "../src/session-search/types";

function digest(id: string, prompts: string[], endedAt = 0): SessionDigest {
	return {
		agentId: "claude",
		sessionId: id,
		cwd: `/w/${id}`,
		branch: id,
		startedAt: endedAt,
		endedAt,
		prompts,
		path: `/t/${id}.jsonl`,
		mtimeMs: 0,
	};
}
const input = (d: SessionDigest, ...titles: string[]) => ({ digest: d, titles });

describe("digest", () => {
	test("keeps what the user typed", () => {
		expect(cleanPrompt("  make the   sidebar  flicker stop ")).toBe(
			"make the sidebar flicker stop",
		);
	});

	test("drops the harness's own injected blocks", () => {
		expect(cleanPrompt("<command-message>merge</command-message>")).toBe("");
		expect(cleanPrompt("<system-reminder>be nice</system-reminder>")).toBe("");
		expect(cleanPrompt("[Request interrupted by user]")).toBe("");
	});

	test("keeps the user's words when a block is only part of the message", () => {
		expect(cleanPrompt("<system-reminder>ctx</system-reminder> fix the caret")).toBe(
			"fix the caret",
		);
	});

	test("flattens block-array content", () => {
		expect(
			contentText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]),
		).toBe("a  b");
	});

	test("pushPrompt skips empties", () => {
		const out: string[] = [];
		pushPrompt(out, "   ");
		pushPrompt(out, "real words");
		expect(out).toEqual(["real words"]);
	});
});

describe("terms", () => {
	test("drops stopwords and punctuation", () => {
		expect(terms("the session Where I fixed the CARET!")).toEqual(["fixed", "caret"]);
	});
});

describe("rank", () => {
	test("finds the session that used the words", () => {
		const hits = rank(
			[
				input(digest("a", ["make the terminal caret render"])),
				input(digest("b", ["add a merge queue"])),
			],
			"caret",
			5,
		);
		expect(hits.map((h) => h.digest.sessionId)).toEqual(["a"]);
		expect(hits[0]?.excerpts[0]).toBe("make the terminal caret render");
	});

	test("a match in the task title outweighs one in the body", () => {
		const body = input(digest("body", ["something about the caret here"]));
		const title = input(digest("title", ["unrelated chatter"]), "caret fixes");
		const hits = rank([body, title], "caret", 5);
		expect(hits[0]?.digest.sessionId).toBe("title");
	});

	test("length normalization keeps a long paste from burying a short answer", () => {
		const short = input(digest("short", ["the caret is invisible"]));
		const long = input(digest("long", [`${"unrelated words ".repeat(200)} caret`]));
		const hits = rank([short, long], "caret", 5);
		expect(hits[0]?.digest.sessionId).toBe("short");
	});

	test("a whole word beats a prefix match", () => {
		const word = input(digest("word", ["run it in a box"]));
		const prefix = input(digest("prefix", ["boxd machine new", "boxd auth login"]));
		const hits = rank([word, prefix], "box", 5);
		expect(hits[0]?.digest.sessionId).toBe("word");
	});

	test("matching every typed term beats repeating one", () => {
		const both = input(digest("both", ["the caret in the titlebar"]));
		const one = input(digest("one", ["caret caret caret caret"]));
		const hits = rank([both, one], "caret titlebar", 5);
		expect(hits[0]?.digest.sessionId).toBe("both");
	});

	test("expansions find a session the typed words miss", () => {
		const typed = input(digest("typed", ["fix the consent dialog"]));
		const expanded = input(digest("expanded", ["ask before the first connection"]));
		expect(rank([typed, expanded], "consent", 5)).toHaveLength(1);
		const widened = rank([typed, expanded], "consent", 5, { expansions: ["connection"] });
		expect(widened.map((h) => h.digest.sessionId).sort()).toEqual(["expanded", "typed"]);
	});

	test("a term the user typed counts for more than one the model suggested", () => {
		const typed = input(digest("typed", ["the consent dialog"]));
		const expanded = input(digest("expanded", ["the connection dialog"]));
		const hits = rank([typed, expanded], "consent", 5, { expansions: ["connection"] });
		expect(hits[0]?.digest.sessionId).toBe("typed");
	});

	test("recency only breaks ties", () => {
		const now = 1_000_000_000_000;
		const day = 24 * 60 * 60 * 1000;
		const old = input(digest("old", ["the caret"], now - 60 * day));
		const fresh = input(digest("fresh", ["the caret"], now - day));
		expect(rank([old, fresh], "caret", 5, { now })[0]?.digest.sessionId).toBe("fresh");
		// ...but never over a genuinely better match.
		const better = input(digest("better", ["the caret in the caret field"], now - 60 * day));
		const worse = input(
			digest("worse", [`one caret ${"and a lot of other words ".repeat(20)}`], now - day),
		);
		expect(rank([better, worse], "caret", 5, { now })[0]?.digest.sessionId).toBe("better");
	});

	test("an empty or stopword-only query matches nothing", () => {
		const only = [input(digest("a", ["anything"]))];
		expect(rank(only, "", 5)).toEqual([]);
		expect(rank(only, "the and of", 5)).toEqual([]);
	});
});

describe("verdicts", () => {
	test("reads JSON out of a fenced reply", () => {
		expect(extractJson('```json\n{"results":[]}\n```')).toEqual({ results: [] });
	});

	test("reads JSON out of a reply with prose around it", () => {
		expect(extractJson('Here you go: {"results":[]} — hope that helps')).toEqual({ results: [] });
	});

	test("returns null rather than throwing on junk", () => {
		expect(extractJson("I cannot help with that")).toBeNull();
	});

	test("drops ids that were never candidates", () => {
		const reply =
			'{"results":[{"id":"real","why":"w","confidence":"high"},{"id":"made-up","why":"w"}]}';
		expect(parseVerdicts(reply, new Set(["real"]))).toEqual([
			{ sessionId: "real", why: "w", confidence: "high" },
		]);
	});

	test("defaults an unusable confidence to low, and dedupes", () => {
		const reply =
			'{"results":[{"id":"a","why":"w","confidence":"certain"},{"id":"a","why":"again"}]}';
		expect(parseVerdicts(reply, new Set(["a"]))).toEqual([
			{ sessionId: "a", why: "w", confidence: "low" },
		]);
	});
});
