// Task tags on the desktop: the shared rule set from @ateam/protocol (one
// vocabulary for the Mac and the phone), plus this client's icon per tag.
import {
	MAX_TAGS,
	matchesTagQuery,
	TASK_TAG_RULES,
	tagsFor,
	taskTag,
	taskTags,
} from "@ateam/protocol";
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

const ICONS: Record<string, LucideIcon> = {
	bug: Bug,
	docs: BookOpen,
	auth: Lock,
	ui: Palette,
	test: FlaskConical,
	db: Database,
	api: Server,
	perf: Gauge,
	refactor: Wrench,
	release: Rocket,
	feat: Sparkles,
	content: FilePen,
};

// The shared rules with this client's icons attached, in the shared order.
export const TAG_RULES: TagRule[] = TASK_TAG_RULES.map((r) => ({
	tag: r.tag,
	icon: ICONS[r.tag] ?? GitBranch,
	re: r.re,
}));

/** Pick an icon from what the task name suggests. First match wins; GitBranch
 *  is the default. */
export function taskIcon(name: string): LucideIcon {
	const tag = taskTag(name);
	return (tag && ICONS[tag]) || GitBranch;
}

export { MAX_TAGS, matchesTagQuery, tagsFor, taskTags };
