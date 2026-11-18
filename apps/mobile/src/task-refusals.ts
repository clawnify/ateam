// How a box's refusal to delete or archive a task reads (task-actions.ts). Pure
// TS, no React Native imports, so it runs under bun test.

/** The box refused a plain delete because work would be lost (git's own words). */
export function needsForce(message: string): boolean {
	return /modified or untracked|not fully merged|use --force/i.test(message);
}

export const said = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** An older box has no archive: say that, not "Unknown method". */
export function archiveError(message: string): string {
	return /unknown method/i.test(message)
		? "This box runs an older Ateam with no archive. Update it from Boxes."
		: message;
}
