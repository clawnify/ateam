/** Readable name derived from a prompt's first words (shared by the task composer and loop forms). */
export function titleFromPrompt(p: string): string {
	return p.trim().split(/\s+/).slice(0, 6).join(" ").slice(0, 60);
}
