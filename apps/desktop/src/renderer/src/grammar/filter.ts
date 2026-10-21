/** One grammar problem in a draft, as plain data (Harper's Lint objects can't cross a worker). */
export interface GrammarIssue {
	start: number;
	end: number;
	problem: string;
	message: string;
	kind: string;
	/** What to write instead, each with the whole draft as it reads once applied. */
	suggestions: { label: string; result: string }[];
}

/**
 * Harper's lint kinds that are noise for a prompt to a coding agent. Prompts are
 * casual and lowercase by habit ("fix the bug"), and nobody wants to be told to
 * write "dependencies" instead of "deps" while instructing a machine.
 */
const QUIET_KINDS = new Set([
	"Capitalization",
	"Style",
	"Readability",
	"Enhancement",
	"Formatting",
	"Regionalism",
]);

/** Characters that only show up inside code, paths, flags and handles. */
const CODE_CHARS = /[/\\._@#:=<>(){}[\]$`~|0-9]/;

/**
 * Whether the whitespace-delimited token around [start, end) reads as code
 * rather than prose: `apps/desktop/src`, `useEffect`, `PromptComposer`,
 * `--yolo`. Harper reports just the sub-word (`src`), so the verdict has to
 * look at the whole token. Sentence punctuation at its edges doesn't count.
 */
export function looksLikeCode(text: string, start: number, end: number): boolean {
	let a = start;
	let b = end;
	while (a > 0 && !/\s/.test(text.charAt(a - 1))) a--;
	while (b < text.length && !/\s/.test(text.charAt(b))) b++;
	const token = text.slice(a, b).replace(/^["'(]+|[.,;:!?)"']+$/g, "");
	// camelCase / PascalCase is a capital after a lowercase letter; a leading
	// dash is a flag (hyphens inside a word are ordinary prose).
	return CODE_CHARS.test(token) || /[a-z][A-Z]/.test(token) || token.startsWith("-");
}

/** Keep only what is worth interrupting someone typing a prompt for. */
export function worthFlagging(text: string, issue: GrammarIssue): boolean {
	return !QUIET_KINDS.has(issue.kind) && !looksLikeCode(text, issue.start, issue.end);
}

/**
 * The issues to show for a draft, or none when it isn't English. Harper's own
 * isLikelyEnglish says no to exactly the drafts worth checking ("fix the bug
 * wich" fails it), so judge by the result instead: a prompt in another
 * language comes back with most of its words "misspelled".
 */
export function issuesToShow<T extends GrammarIssue>(text: string, lints: T[]): T[] {
	const issues = lints.filter((issue) => worthFlagging(text, issue));
	const words = [...text.matchAll(/\S+/g)].filter(
		(m) => /\p{L}/u.test(m[0]) && !looksLikeCode(text, m.index, m.index + m[0].length),
	).length;
	const misspelled = issues.filter((issue) => issue.kind === "Spelling").length;
	return misspelled * 2 > words ? [] : issues;
}
