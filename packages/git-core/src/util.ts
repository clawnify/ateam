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
