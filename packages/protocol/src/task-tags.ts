// Task tags — the cross-cutting "what KIND of work is this" axis, alongside
// project (where) and column (how far along). Shared by every client so a task
// reads the same on the Mac and the phone; each client maps a tag to its own
// icon set.
//
// The vocabulary is a tuned, closed set of twelve categories, which is exactly
// what a tag taxonomy needs: tagging is automatic from the moment a task is
// created, and it can never drift into `frontend` / `front-end` / `ui` synonyms
// the way a free-form or LLM-generated vocabulary does.
//
// Deliberately DERIVED, not stored: a tag is a function of the task's own text,
// so there is no column to migrate, nothing to backfill, and no way for a tag
// to go stale when a task is renamed. Hand-written tags would need a real column.

/** One category: its chip label and what it matches. */
export interface TaskTagRule {
	tag: string;
	re: RegExp;
}

// Order matters for the ICON (first match wins, see taskTag); tags use every
// match, so a "fix the auth api" task carries bug + auth + api.
export const TASK_TAG_RULES: TaskTagRule[] = [
	{ tag: "bug", re: /\b(bug|fix|hotfix|patch|broken|crash|error)\b/i },
	{ tag: "docs", re: /\b(readme|docs?|wiki|guide|changelog)\b/i },
	{ tag: "auth", re: /\b(auth|login|signin|security|permission|token|oauth)\b/i },
	{ tag: "ui", re: /\b(ui|ux|style|css|design|theme|button|layout|icon)\b/i },
	{ tag: "test", re: /\b(test|spec|e2e|coverage)\b/i },
	{ tag: "db", re: /\b(db|database|schema|migration|sql|drizzle|query)\b/i },
	{ tag: "api", re: /\b(api|endpoint|server|backend|route|webhook)\b/i },
	{ tag: "perf", re: /\b(perf|performance|optimi|speed|cache|latency)\b/i },
	{ tag: "refactor", re: /\b(refactor|cleanup|chore|tidy|rename|config|setup)\b/i },
	{ tag: "release", re: /\b(release|deploy|launch|ship|publish)\b/i },
	{ tag: "feat", re: /\b(feat|feature|add|new|implement|create)\b/i },
	{ tag: "content", re: /\b(update|edit|change|tweak|copy|content)\b/i },
];

/** Cap per card. Beyond three, chips stop being a glance and become a wall. */
export const MAX_TAGS = 3;

/** The category the task name suggests first, for its icon; null for a plain task. */
export function taskTag(name: string): string | null {
	for (const rule of TASK_TAG_RULES) if (rule.re.test(name)) return rule.tag;
	return null;
}

/**
 * Every category the task's text matches, in rule order, capped at MAX_TAGS.
 * Reads the name and the description: the name is often a truncated first line
 * of the prompt, so the description carries signal the title lost.
 */
export function taskTags(name: string, description?: string | null): string[] {
	const text = description ? `${name} ${description}` : name;
	const hits: string[] = [];
	for (const rule of TASK_TAG_RULES) {
		if (rule.re.test(text)) hits.push(rule.tag);
		if (hits.length === MAX_TAGS) break;
	}
	return hits;
}

/**
 * The tags to show for a task: the model's, when it produced any, otherwise the
 * keyword reading of its text. Model tags win because keywords miss roughly
 * three quarters of real tasks; the fallback still covers every card created
 * before tagging existed, and any card whose tagging call failed.
 */
export function tagsFor(task: {
	name: string;
	description?: string | null;
	tags?: string[] | null;
}): string[] {
	if (task.tags?.length) return task.tags.slice(0, MAX_TAGS);
	return taskTags(task.name, task.description);
}

/**
 * Does this task match a `#tag` search term? `#a` matches the `api` and `auth`
 * chips, so typing narrows as you go rather than only hitting on a full word.
 */
export function matchesTagQuery(
	term: string,
	task: { name: string; description?: string | null; tags?: string[] | null },
): boolean {
	const wanted = term.replace(/^#/, "").toLowerCase();
	if (!wanted) return true;
	return tagsFor(task).some((t) => t.startsWith(wanted));
}
