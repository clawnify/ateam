/**
 * Turn a human task name into a git-safe slug / branch name.
 * Lowercase, non-alphanumeric runs → single hyphen, trimmed. Returns "" for
 * input that contains no usable characters (callers treat that as invalid).
 */
export function slugify(name: string): string {
	return name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "") // strip diacritics
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-")
		.slice(0, 80);
}

/**
 * Whether `branch` is the one a task named `name` was given: the name's slug,
 * or that slug with the `-2`, `-3` suffix a repeated name gets (allocateNames in
 * task.ts). Lets a task be found by the name it had when its branch was made,
 * after its name has changed; a repeated name matches every task that had it.
 */
export function isBranchForName(branch: string, name: string): boolean {
	const slug = slugify(name);
	if (!slug) return false;
	if (branch === slug) return true;
	return branch.startsWith(`${slug}-`) && /^\d+$/.test(branch.slice(slug.length + 1));
}
