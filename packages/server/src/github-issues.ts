import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CreateGithubIssueInput, GithubIssueDTO, GithubIssuesDTO } from "@ateam/protocol";

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

/** Turns a failed gh call into the message the dialog shows. */
function issueCreateError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	if (/ENOENT/.test(message)) return new Error("Install GitHub CLI (gh) to create issues.");
	const stderr = String((error as { stderr?: unknown }).stderr ?? "");
	if (/unknown flag: --attach/.test(stderr))
		return new Error("Update GitHub CLI (gh) to 2.99 or newer to attach images.");
	if (/auth login|GH_TOKEN|HTTP 40[13]/.test(message))
		return new Error(
			"GitHub access failed. Check gh auth status and that this account can open issues on the repository.",
		);
	// gh prints GitHub's reason ("Issues are disabled for this repo (HTTP 410)",
	// "attaching files requires write access to the repository").
	const reason = stderr.trim().split("\n")[0]?.replace(/^gh: /, "");
	return new Error(`Could not create the GitHub issue${reason ? `: ${reason}` : "."}`);
}

/** gh's own limits (internal/attachments/userasset.go): it refuses anything else. */
const IMAGE_NAME = /^[\w-][\w.-]*\.(png|jpe?g|gif|webp|svg)$/i;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 50;

type Run = (
	file: string,
	args: string[],
	opts: { cwd?: string; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

/** Files a new issue with the gh login's identity. The body goes over stdin (or a
 * file) so it never lands on a command line or hits the argument-length limit. */
export async function createGithubIssue(
	repository: string,
	input: CreateGithubIssueInput,
	run: Run = exec,
): Promise<GithubIssueDTO> {
	const name = repositoryName(repository);
	const title = typeof input?.title === "string" ? input.title.trim() : "";
	if (!title) throw new Error("An issue title is required.");
	if (typeof input.body !== "string") throw new Error("Invalid issue description.");
	if (input.images?.length) return createWithImages(name, title, input.body, input.images, run);
	const request = exec(
		"gh",
		["api", "--hostname", "github.com", "--method", "POST", `repos/${name}/issues`, "--input", "-"],
		{ timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
	);
	request.child.stdin?.end(JSON.stringify({ title, body: input.body }));
	let stdout: string;
	try {
		({ stdout } = await request);
	} catch (error) {
		throw issueCreateError(error);
	}
	const [issue] = parseIssuePages([[JSON.parse(stdout)]], name);
	if (!issue) throw new Error("Invalid GitHub issue response.");
	return issue;
}

/** The REST API has no way to attach a file, so this goes through `gh issue create
 * --attach`, which uploads to the same asset store as a drag into github.com and
 * rewrites each `./<name>` reference in the body to the uploaded URL. The images
 * are staged in a private temp dir that is the command's cwd, and removed after. */
async function createWithImages(
	name: string,
	title: string,
	body: string,
	images: CreateGithubIssueInput["images"] & {},
	run: Run,
): Promise<GithubIssueDTO> {
	if (!Array.isArray(images) || images.length > MAX_IMAGES)
		throw new Error(`Attach at most ${MAX_IMAGES} images.`);
	const names = new Set<string>();
	const files = images.map((image) => {
		const fileName = typeof image?.name === "string" ? image.name : "";
		if (!IMAGE_NAME.test(fileName) || names.has(fileName.toLowerCase()))
			throw new Error(`Invalid image name: ${fileName || "(none)"}.`);
		names.add(fileName.toLowerCase());
		const bytes = Buffer.from(typeof image.base64 === "string" ? image.base64 : "", "base64");
		if (bytes.length === 0) throw new Error(`${fileName} is empty.`);
		if (bytes.length > MAX_IMAGE_BYTES)
			throw new Error(`${fileName} is over GitHub's 10 MB limit.`);
		return { fileName, bytes };
	});
	const dir = mkdtempSync(join(tmpdir(), "ateam-issue-"));
	try {
		for (const { fileName, bytes } of files) writeFileSync(join(dir, fileName), bytes);
		writeFileSync(join(dir, ".body.md"), body);
		let stdout: string;
		try {
			({ stdout } = await run(
				"gh",
				[
					"issue",
					"create",
					"--repo",
					`github.com/${name}`,
					"--title",
					title,
					"--body-file",
					".body.md",
					...files.flatMap(({ fileName }) => ["--attach", `./${fileName}`]),
				],
				{ cwd: dir, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
			));
		} catch (error) {
			// Some uploads failing still files the issue (with the ones that made it)
			// and prints its URL; it exists now, so report it rather than invite a
			// retry that files a duplicate.
			stdout = String((error as { stdout?: unknown }).stdout ?? "");
			if (!issueNumber(stdout, name)) throw issueCreateError(error);
		}
		const number = issueNumber(stdout, name);
		if (!number) throw new Error("Invalid GitHub issue response.");
		try {
			const { stdout: json } = await run(
				"gh",
				["api", "--hostname", "github.com", `repos/${name}/issues/${number}`],
				{ timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
			);
			const [issue] = parseIssuePages([[JSON.parse(json)]], name);
			if (issue) return issue;
		} catch {
			/* created; the read-back only fills in author and the rewritten body */
		}
		return {
			number,
			title,
			body,
			url: `https://github.com/${name}/issues/${number}`,
			author: "you",
			labels: [],
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** The issue number from the URL `gh issue create` prints last. */
function issueNumber(stdout: string, name: string): number | null {
	const urls = [...stdout.matchAll(/https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)/g)];
	const last = urls.at(-1);
	return last && last[1]?.toLowerCase() === name ? Number(last[2]) : null;
}

/** Shared across windows. Coalesce requests and retain the last good result on
 * failure; bound the cache so visiting many projects cannot grow it forever. */
export class GithubIssues {
	private cache = new Map<string, GithubIssuesDTO & { checkedAt: number }>();
	private pending = new Map<string, Promise<GithubIssuesDTO>>();
	constructor(
		private fetchIssues = fetchGithubIssues,
		private now = Date.now,
		private createIssue = createGithubIssue,
	) {}

	/** Seeds the cache with the new issue: GitHub's list endpoint can lag a fresh
	 * create, and the board should show it on the very next read. */
	async create(repository: string, input: CreateGithubIssueInput) {
		const key = repositoryName(repository);
		const issue = await this.createIssue(key, input);
		const cached = this.cache.get(key);
		if (cached)
			this.cache.set(key, {
				...cached,
				issues: [issue, ...cached.issues.filter((i) => i.number !== issue.number)],
			});
		return issue;
	}

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
