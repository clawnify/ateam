/**
 * Minimal git client surface used by the porcelain parsers. `simple-git`'s
 * `SimpleGit` satisfies this, but keeping it narrow means the pure parsing
 * helpers (worktree-list) stay trivially unit-testable with a fake.
 */
export interface GitClient {
	raw(commands: string[]): Promise<string>;
}
