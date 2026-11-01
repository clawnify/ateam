// Pointing at a task from the Lead chat's composer. Typing "@" lists the tasks;
// the one picked goes into the draft as "@<its name>", and on send each such
// token becomes the link the Lead itself writes, [name](task:<id>): the Lead
// gets the exact task, and the thread draws it as a chip like the Lead's own.
// Pure, so it is tested without a DOM.
import { TASK_LINK_SCHEME } from "@ateam/protocol";

export const REF_TRIGGER = "@";

/** A task picked into the draft: the text that stands for it, and its id. */
export interface DraftRef {
	token: string;
	taskId: string;
}

/** What a task offers the picker; TaskDTO has it all. */
export interface RefTask {
	id: string;
	name: string;
	branch: string;
	projectId: string;
	lastEventAt: number | null;
}

/** The "@" being typed before the caret, and what follows it so far. Only at
 *  the start or after whitespace, so an email ("me@example.com") never opens the list,
 *  and not on a task already picked, or the list would reopen on it. */
export function refQuery(
	text: string,
	caret: number,
	refs: DraftRef[],
): { start: number; query: string } | null {
	const before = text.slice(0, caret);
	const start = before.lastIndexOf(REF_TRIGGER);
	if (start < 0) return null;
	if (start > 0 && !/\s/.test(before.charAt(start - 1))) return null;
	const query = before.slice(start + 1);
	// "meet @ 5" is prose: a reference starts right after the @.
	if (query.includes("\n") || /^\s/.test(query)) return null;
	if (refs.some((r) => text.startsWith(r.token, start))) return null;
	return { start, query };
}

/** The tasks a query names, best first: the name starting with it, then a word
 *  of the name starting with it, then the rest; newest first within each. Every
 *  word typed must appear in the name, the branch or the project's name. */
export function matchTasks<T extends RefTask>(
	tasks: T[],
	query: string,
	projectName: (projectId: string) => string | undefined,
	limit = 50,
): T[] {
	const q = query.trim().toLowerCase().replace(/\s+/g, " ");
	const terms = q ? q.split(" ") : [];
	const rank = (t: T) => {
		const name = t.name.toLowerCase();
		if (name.startsWith(q)) return 0;
		return name.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(terms[0] ?? "")) ? 1 : 2;
	};
	return tasks
		.filter((t) => {
			const hay = `${t.name} ${t.branch} ${projectName(t.projectId) ?? ""}`.toLowerCase();
			return terms.every((w) => hay.includes(w));
		})
		.map((t) => ({ t, r: rank(t) }))
		.sort((a, b) => a.r - b.r || (b.t.lastEventAt ?? 0) - (a.t.lastEventAt ?? 0))
		.slice(0, limit)
		.map((x) => x.t);
}

/** The token a picked task stands as in the draft: "@" and its name on one
 *  line, with the branch added when another task picked into this draft
 *  already has that name, so each token still means one task. */
export function tokenFor(task: RefTask, refs: DraftRef[]): string {
	const name = task.name.replace(/\s+/g, " ").trim() || task.branch;
	const plain = `${REF_TRIGGER}${name}`;
	return refs.some((r) => r.token === plain && r.taskId !== task.id)
		? `${plain} (${task.branch})`
		: plain;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The tokens still in the text, longest first, so "@fix login" wins over "@fix". */
function tokenPattern(text: string, refs: DraftRef[]): RegExp | null {
	const live = refs.filter((r) => text.includes(r.token));
	if (!live.length) return null;
	const alts = [...new Set(live.map((r) => r.token))]
		.sort((a, b) => b.length - a.length)
		.map(escapeRe);
	return new RegExp(alts.join("|"), "g");
}

/** The draft cut into plain text and picked tasks, for highlighting the tokens. */
export function splitDraft(
	text: string,
	refs: DraftRef[],
): Array<{ text: string; ref?: DraftRef }> {
	const re = tokenPattern(text, refs);
	if (!re) return [{ text }];
	const out: Array<{ text: string; ref?: DraftRef }> = [];
	let last = 0;
	for (const m of text.matchAll(re)) {
		const at = m.index ?? 0;
		if (at > last) out.push({ text: text.slice(last, at) });
		out.push({ text: m[0], ref: refs.find((r) => r.token === m[0]) });
		last = at + m[0].length;
	}
	if (last < text.length) out.push({ text: text.slice(last) });
	return out;
}

/** A markdown link's text, with the characters that would end it escaped. */
const linkLabel = (s: string) => s.replace(/[\\[\]]/g, "\\$&");

/** What is sent: every picked task's token replaced by its link. A token the
 *  user edited no longer matches and goes as they left it. */
export function expandRefs(text: string, refs: DraftRef[]): string {
	const re = tokenPattern(text, refs);
	if (!re) return text;
	return text.replace(re, (token) => {
		const ref = refs.find((r) => r.token === token);
		return ref
			? `[${linkLabel(token.slice(REF_TRIGGER.length))}](${TASK_LINK_SCHEME}${ref.taskId})`
			: token;
	});
}

const TASK_LINK = new RegExp(
	`\\[((?:\\\\.|[^\\\\\\]\\n])+)\\]\\(${escapeRe(TASK_LINK_SCHEME)}([^)\\s]+)\\)`,
	"g",
);

/** A sent message cut into plain text and the tasks it links, for the chips. */
export function splitSent(
	text: string,
): Array<{ text: string } | { label: string; target: string }> {
	const out: Array<{ text: string } | { label: string; target: string }> = [];
	let last = 0;
	for (const m of text.matchAll(TASK_LINK)) {
		const at = m.index ?? 0;
		if (at > last) out.push({ text: text.slice(last, at) });
		out.push({ label: (m[1] ?? "").replace(/\\(.)/g, "$1"), target: m[2] ?? "" });
		last = at + m[0].length;
	}
	if (last < text.length) out.push({ text: text.slice(last) });
	return out;
}
