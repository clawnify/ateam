/// <reference lib="webworker" />
// Harper (a local, offline grammar checker compiled to WebAssembly) runs here,
// off the UI thread: its first lint of an unfamiliar word can take a second.
// Our own worker, not Harper's WorkerLinter, which spawns a blob: worker that
// the renderer's CSP rightly refuses.
import { LocalLinter } from "harper.js";
import { binary } from "harper.js/binary";
import { type GrammarIssue, issuesToShow } from "./filter";

const linter = new LocalLinter({ binary });

self.onmessage = async (e: MessageEvent<{ id: number; text: string }>) => {
	const { id, text } = e.data;
	let issues: GrammarIssue[] = [];
	try {
		const lints = await linter.lint(text, { language: "markdown" });
		const kept = issuesToShow(
			text,
			lints.map((l, i) => {
				const span = l.span();
				return {
					start: span.start,
					end: span.end,
					problem: l.get_problem_text(),
					message: l.message(),
					kind: l.lint_kind(),
					suggestions: [],
					lint: i,
				};
			}),
		);
		// Only now, for the few that survive the filter: Harper applies its own
		// suggestion (replace, remove or insert) so the UI just swaps drafts.
		issues = await Promise.all(
			kept.map(async ({ lint, ...issue }) => {
				const l = lints[lint];
				const suggestions = l
					? await Promise.all(
							l.suggestions().map(async (s) => ({
								label: s.get_replacement_text() || "delete",
								result: await linter.applySuggestion(text, l, s),
							})),
						)
					: [];
				return { ...issue, suggestions };
			}),
		);
	} catch (err) {
		console.error("[grammar]", err);
	}
	self.postMessage({ id, issues });
};
