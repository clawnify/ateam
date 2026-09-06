// Task tags on the phone: the shared rule set from @ateam/protocol (one
// vocabulary for the Mac and the phone), plus this client's Feather icon per tag.
import { tagsFor, taskTag } from "@ateam/protocol";

type FeatherName =
	| "alert-triangle"
	| "book-open"
	| "lock"
	| "layout"
	| "check-square"
	| "database"
	| "server"
	| "zap"
	| "tool"
	| "send"
	| "star"
	| "edit-3"
	| "git-branch";

const ICONS: Record<string, FeatherName> = {
	bug: "alert-triangle",
	docs: "book-open",
	auth: "lock",
	ui: "layout",
	test: "check-square",
	db: "database",
	api: "server",
	perf: "zap",
	refactor: "tool",
	release: "send",
	feat: "star",
	content: "edit-3",
};

/** Icon for a task without an agent: first matching rule, else a branch. */
export function taskIconName(name: string): FeatherName {
	const tag = taskTag(name);
	return (tag && ICONS[tag]) || "git-branch";
}

export { tagsFor };
