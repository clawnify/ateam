import type { GrammarIssue } from "./filter";

// One worker for every terminal (Mission Control mounts many), started on the
// first check so nobody pays for the 20 MB wasm until they type a prompt.
let worker: Worker | null = null;
let nextId = 0;
const waiting = new Map<number, (issues: GrammarIssue[]) => void>();

/**
 * Grammar problems in `text` worth showing: Harper's, after the prompt-noise
 * filter, then, with an OpenRouter key and the setting on, only those Jev
 * judges real mistakes. Without Jev's answer, every one of Harper's shows.
 */
export async function checkGrammar(text: string): Promise<GrammarIssue[]> {
	const issues = await lint(text);
	if (issues.length === 0) return issues;
	const keep = await window.ateamHost
		.judgeGrammar(
			text,
			issues.map(({ start, end, problem, message, suggestions }) => ({
				start,
				end,
				problem,
				message,
				suggestions: suggestions.map((s) => s.label),
			})),
		)
		.catch(() => null);
	return keep ? issues.filter((_, i) => keep[i]) : issues;
}

function lint(text: string): Promise<GrammarIssue[]> {
	if (!worker) {
		worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
		worker.onmessage = (e: MessageEvent<{ id: number; issues: GrammarIssue[] }>) => {
			waiting.get(e.data.id)?.(e.data.issues);
			waiting.delete(e.data.id);
		};
	}
	const id = nextId++;
	return new Promise((resolve) => {
		waiting.set(id, resolve);
		worker?.postMessage({ id, text });
	});
}
