// Task tags — the cross-cutting "what KIND of work is this" axis, alongside
// project (where) and column (how far along).
//
// The vocabulary is NOT new. These rules already existed in App.tsx to pick a
// card icon from the task name; they are a tuned, closed set of twelve
// categories, which is exactly what a tag taxonomy needs. Reusing them means
// tagging is automatic from the moment a task is created, and it can never
// drift into `frontend` / `front-end` / `ui` synonyms the way a free-form or
// LLM-generated vocabulary does. The icon and the tags are now two readings of
// one rule set rather than two things to keep in sync.
//
// Deliberately DERIVED, not stored: a tag is a function of the task's own text,
// so there is no column to migrate, nothing to backfill across the hundreds of
// existing cards, and no way for a tag to go stale when a task is renamed.
// Hand-written tags would need a real column; nobody has asked for those yet.
//
// Pure + unit-tested (see task-tags.test.ts).
import {
	BookOpen,
	Bug,
	Database,
	FilePen,
	FlaskConical,
	Gauge,
	GitBranch,
	Lock,
	type LucideIcon,
	Palette,
	Rocket,
	Server,
	Sparkles,
	Wrench,
} from "lucide-react";

/** One category: its chip label, its card icon, and what it matches. */
export interface TagRule {
	tag: string;
	icon: LucideIcon;
	re: RegExp;
}

// Order matters for the ICON (first match wins, as it always has); tags use
// every match, so a "fix the auth api" task carries bug + auth + api.
export const TAG_RULES: TagRule[] = [
	{ tag: "bug", icon: Bug, re: /\b(bug|fix|hotfix|patch|broken|crash|error)\b/i },
	{ tag: "docs", icon: BookOpen, re: /\b(readme|docs?|wiki|guide|changelog)\b/i },
	{ tag: "auth", icon: Lock, re: /\b(auth|login|signin|security|permission|token|oauth)\b/i },
	{ tag: "ui", icon: Palette, re: /\b(ui|ux|style|css|design|theme|button|layout|icon)\b/i },
	{ tag: "test", icon: FlaskConical, re: /\b(test|spec|e2e|coverage)\b/i },
	{ tag: "db", icon: Database, re: /\b(db|database|schema|migration|sql|drizzle|query)\b/i },
	{ tag: "api", icon: Server, re: /\b(api|endpoint|server|backend|route|webhook)\b/i },
	{ tag: "perf", icon: Gauge, re: /\b(perf|performance|optimi|speed|cache|latency)\b/i },
	{ tag: "refactor", icon: Wrench, re: /\b(refactor|cleanup|chore|tidy|rename|config|setup)\b/i },
	{ tag: "release", icon: Rocket, re: /\b(release|deploy|launch|ship|publish)\b/i },
	{ tag: "feat", icon: Sparkles, re: /\b(feat|feature|add|new|implement|create)\b/i },
	{ tag: "content", icon: FilePen, re: /\b(update|edit|change|tweak|copy|content)\b/i },
];

/** Cap per card. Beyond three, chips stop being a glance and become a wall. */
export const MAX_TAGS = 3;

/** Pick an icon from what the task name suggests. First match wins; GitBranch
 *  is the default. Unchanged behaviour, now sharing one rule set with tags. */
export function taskIcon(name: string): LucideIcon {
	for (const rule of TAG_RULES) if (rule.re.test(name)) return rule.icon;
	return GitBranch;
}

/**
 * Every category the task's text matches, in rule order, capped at MAX_TAGS.
 * Reads the name and the description: the name is often a truncated first line
 * of the prompt, so the description carries signal the title lost.
 */
export function taskTags(name: string, description?: string | null): string[] {
	const text = description ? `${name} ${description}` : name;
	const hits: string[] = [];
	for (const rule of TAG_RULES) {
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
