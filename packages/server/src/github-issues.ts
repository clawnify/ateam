import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GithubIssueDTO, GithubIssuesDTO } from "@ateam/protocol";

const exec = promisify(execFile);

export function repositoryName(value: string): string {
	if (
		typeof value !== "string" ||
		!/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(value) ||
		/\/\.{1,2}$/.test(value)
	) {
		throw new Error("Invalid GitHub repository: expected owner/name.");
	}
	return value.toLowerCase();
}

export function parseIssuePages(value: unknown, repository: string): GithubIssueDTO[] {
	if (!Array.isArray(value) || !value.every(Array.isArray))
		throw new Error("Invalid GitHub issue response.");
	const issues = new Map<number, GithubIssueDTO>();
	for (const issue of value.flat()) {
		if (!issue || typeof issue !== "object") throw new Error("Invalid GitHub issue response.");
		if (issue.pull_request) continue;
		if (
			!Number.isSafeInteger(issue.number) ||
			issue.number <= 0 ||
			typeof issue.title !== "string" ||
			(issue.body !== null && typeof issue.body !== "string") ||
			!Array.isArray(issue.labels)
		) {
			throw new Error("Invalid GitHub issue response.");
		}
		issues.set(issue.number, {
			number: issue.number,
			title: issue.title,
			body: issue.body ?? "",
			url: `https://github.com/${repository}/issues/${issue.number}`,
			author: typeof issue.user?.login === "string" ? issue.user.login : "ghost",
			labels: issue.labels.flatMap((label: unknown) => {
				if (typeof label === "string") return [label];
				return label &&
					typeof label === "object" &&
					"name" in label &&
					typeof label.name === "string"
					? [label.name]
					: [];
			}),
		});
	}
	return [...issues.values()];
}

export async function fetchGithubIssues(repository: string): Promise<GithubIssueDTO[]> {
	const name = repositoryName(repository);
	const { stdout } = await exec(
		"gh",
		[
			"api",
			"--hostname",
			"github.com",
			"--method",
			"GET",
			"--paginate",
			"--slurp",
			`repos/${name}/issues?state=open&per_page=100`,
		],
		{
			timeout: 60_000,
			maxBuffer: 32 * 1024 * 1024,
		},
	);
	return parseIssuePages(JSON.parse(stdout), name);
}

/** Shared across windows. Coalesce requests and retain the last good result on
 * failure; bound the cache so visiting many projects cannot grow it forever. */
export class GithubIssues {
	private cache = new Map<string, GithubIssuesDTO & { checkedAt: number }>();
	private pending = new Map<string, Promise<GithubIssuesDTO>>();
	constructor(
		private fetchIssues = fetchGithubIssues,
		private now = Date.now,
	) {}

	async list(repository: string, refresh = false): Promise<GithubIssuesDTO> {
		const key = repositoryName(repository);
		const cached = this.cache.get(key);
		const pending = this.pending.get(key);
		if (pending) return pending;
		if (!refresh && cached && this.now() - cached.checkedAt < 60_000) return cached;
		const request = (async () => {
			let result: GithubIssuesDTO;
			try {
				result = { issues: await this.fetchIssues(key), syncedAt: this.now(), error: null };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				result = {
					issues: cached?.issues ?? [],
					syncedAt: cached?.syncedAt ?? null,
					error: /ENOENT/.test(message)
						? "Install GitHub CLI (gh) to sync issues."
						: /auth login|GH_TOKEN|401|403/.test(message)
							? "GitHub access failed. Check gh auth status and repository access on this machine."
							: "Could not sync GitHub issues. Check your connection and repository access, then retry.",
				};
			}
			this.cache.delete(key);
			this.cache.set(key, { ...result, checkedAt: this.now() });
			if (this.cache.size > 30) {
				const oldest = this.cache.keys().next().value;
				if (oldest) this.cache.delete(oldest);
			}
			return result;
		})();
		this.pending.set(key, request);
		try {
			return await request;
		} finally {
			this.pending.delete(key);
		}
	}
}
