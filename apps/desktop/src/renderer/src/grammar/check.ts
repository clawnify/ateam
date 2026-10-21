import type { GrammarIssue } from "./filter";

// One worker for every terminal (Mission Control mounts many), started on the
// first check so nobody pays for the 20 MB wasm until they type a prompt.
let worker: Worker | null = null;
let nextId = 0;
const waiting = new Map<number, (issues: GrammarIssue[]) => void>();

/** Grammar problems in `text` worth showing, after the prompt-noise filter. */
export function checkGrammar(text: string): Promise<GrammarIssue[]> {
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
