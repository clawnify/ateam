import { expect, test } from "bun:test";
import { type GrammarIssue, issuesToShow, looksLikeCode, worthFlagging } from "./filter";

/** An issue over the first occurrence of `problem` in `text`. */
const at = (text: string, problem: string, kind = "Spelling"): GrammarIssue => {
	const start = text.indexOf(problem);
	return { start, end: start + problem.length, problem, message: "", kind, suggestions: [] };
};

const codeAt = (text: string, word: string) => {
	const { start, end } = at(text, word);
	return looksLikeCode(text, start, end);
};

test("identifiers, paths and flags are code, not misspellings", () => {
	const t = "rename PromptComposer, update useEffect in apps/desktop/src and pass --yolo";
	expect(codeAt(t, "PromptComposer")).toBe(true);
	expect(codeAt(t, "useEffect")).toBe(true);
	expect(codeAt(t, "src")).toBe(true);
	expect(codeAt(t, "yolo")).toBe(true);
});

test("a word at the end of a sentence or in quotes is still prose", () => {
	const t = 'it crashes on "wich" button. then it dont work.';
	expect(codeAt(t, "wich")).toBe(false);
	expect(codeAt(t, "work")).toBe(false);
});

test("casual-prompt noise is dropped, real mistakes are kept", () => {
	const t = "fix the well-known bug wich crash the app, its broken";
	expect(worthFlagging(t, at(t, "fix", "Capitalization"))).toBe(false);
	expect(worthFlagging(t, at(t, "wich", "Spelling"))).toBe(true);
	expect(worthFlagging(t, at(t, "its", "Punctuation"))).toBe(true);
});

test("hyphenated words are prose", () => {
	expect(codeAt("a well-knwon bug", "knwon")).toBe(false);
});

test("a short English draft with typos is still checked", () => {
	const t = "fix the bug wich";
	expect(
		issuesToShow(t, [at(t, "fix", "Capitalization"), at(t, "wich")]).map((i) => i.problem),
	).toEqual(["wich"]);
});

test("a draft in another language shows nothing rather than a wall of misspellings", () => {
	const t = "il bug della sidebar non funziona quando clicco";
	const lints = ["il", "della", "funziona", "quando", "clicco"].map((w) => at(t, w));
	expect(issuesToShow(t, lints)).toEqual([]);
});
