import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repo } from "@ateam/db";
import {
	createTask as gitCreateTask,
	registerProject,
} from "@ateam/git-core";
import type { Services } from "./services";

/**
 * Demo mode (GROVE_DEMO=1): seed an ISOLATED profile with synthetic but fully
 * functional data for screenshots — real local git repos (each with a bare
 * "origin" so status/diff/push behave), real worktrees, and task rows in every
 * kanban state. Never touches the normal profile; main/index.ts points
 * userData at ~/.ateam-demo before services boot.
 */

const git = (cwd: string, ...args: string[]): void => {
	execFileSync("git", args, { cwd, stdio: "ignore" });
};

async function write(dir: string, files: Record<string, string>) {
	for (const [rel, content] of Object.entries(files)) {
		const p = join(dir, rel);
		await mkdir(join(p, ".."), { recursive: true });
		await writeFile(p, content, "utf8");
	}
}

interface DemoTask {
	name: string;
	column: "todo" | "running" | "needs_attention" | "review" | "merged";
	agentId?: string;
	agentStatus?: "idle" | "running" | "awaiting_input" | "stopped";
	prNumber?: number;
	isUnread?: boolean;
	ahead?: number;
	dirty?: number;
	/** Files written into the worktree (uncommitted → shows in Changes). */
	changes?: Record<string, string>;
	/** Commit the changes (still shows vs main, plus a tidy worktree). */
	commit?: boolean;
}

interface DemoProject {
	slug: string;
	files: Record<string, string>;
	tasks: DemoTask[];
}

const PROJECTS: DemoProject[] = [
	{
		slug: "aurora",
		files: {
			"README.md":
				"# Aurora\n\nSelf-hosted product analytics — events, funnels, retention.\n",
			"package.json": '{ "name": "aurora", "version": "2.4.1" }\n',
			"src/app.ts":
				'import { router } from "./router"\n\nexport function start() {\n  router.listen(3000)\n}\n',
			"src/api/auth.ts":
				'export function login(user: string, pass: string) {\n  return verify(user, pass)\n}\n\nfunction verify(u: string, p: string) {\n  return u.length > 0 && p.length > 8\n}\n',
			"src/api/events.ts":
				"export async function track(event: string, props: object) {\n  await db.insert({ event, props, at: Date.now() })\n}\n",
		},
		tasks: [
			{
				name: "Add OAuth login flow",
				column: "running",
				agentId: "claude",
				agentStatus: "running",
				ahead: 2,
				dirty: 3,
				changes: {
					"src/api/oauth.ts":
						'import { exchangeCode } from "./oauth-client"\n\nexport async function callback(code: string) {\n  const token = await exchangeCode(code)\n  return createSession(token)\n}\n',
					"src/api/auth.ts":
						'import { callback } from "./oauth"\n\nexport function login(user: string, pass: string) {\n  return verify(user, pass)\n}\n\nexport { callback as oauthCallback }\n\nfunction verify(u: string, p: string) {\n  return u.length > 0 && p.length > 8\n}\n',
				},
			},
			{
				name: "Fix flaky checkout tests",
				column: "needs_attention",
				agentId: "codex",
				agentStatus: "awaiting_input",
				isUnread: true,
				dirty: 1,
				changes: {
					"src/checkout.test.ts":
						'test("applies coupon", async () => {\n  await retry(3, () => checkout({ coupon: "SAVE10" }))\n})\n',
				},
			},
			{
				name: "Dark mode for settings page",
				column: "review",
				agentId: "claude",
				agentStatus: "idle",
				prNumber: 42,
				ahead: 1,
				commit: true,
				changes: {
					"src/ui/theme.ts":
						'export const themes = {\n  light: { bg: "#ffffff", fg: "#0b0b0e" },\n  dark: { bg: "#0b0b0e", fg: "#e6e6ea" },\n}\n',
				},
			},
			{
				name: "Migrate billing to Postgres 16",
				column: "todo",
			},
			{
				name: "Refactor webhook retries",
				column: "merged",
				agentId: "claude",
				agentStatus: "idle",
				prNumber: 38,
			},
		],
	},
	{
		slug: "atlas-api",
		files: {
			"README.md": "# Atlas API\n\nGeospatial REST API for map tiles.\n",
			"src/server.ts":
				'import { createServer } from "./http"\n\ncreateServer().listen(8080)\n',
		},
		tasks: [
			{
				name: "Rate limiting middleware",
				column: "running",
				agentId: "opencode",
				agentStatus: "running",
				dirty: 2,
				changes: {
					"src/middleware/rate-limit.ts":
						"const WINDOW = 60_000\nconst LIMIT = 120\n\nexport function rateLimit(req, res, next) {\n  // sliding window per API key\n  next()\n}\n",
				},
			},
			{
				name: "OpenAPI 3.1 spec",
				column: "review",
				agentId: "claude",
				agentStatus: "idle",
				prNumber: 7,
				isUnread: true,
			},
		],
	},
];

export async function seedDemo(services: Services): Promise<void> {
	const db = services.db;
	if (repo.listProjects(db).length > 0) return; // already seeded

	const reposRoot = join(services.userDataDir, "repos");
	await mkdir(reposRoot, { recursive: true });

	for (const proj of PROJECTS) {
		const dir = join(reposRoot, proj.slug);
		if (!existsSync(dir)) {
			await mkdir(dir, { recursive: true });
			await write(dir, proj.files);
			git(dir, "init", "-b", "main");
			git(dir, "add", "-A");
			git(dir, "commit", "-m", "Initial commit");
			// A local bare "origin" so tracking/diff/push behave like a real repo.
			git(reposRoot, "init", "--bare", "-b", "main", `${proj.slug}-origin.git`);
			git(dir, "remote", "add", "origin", join(reposRoot, `${proj.slug}-origin.git`));
			git(dir, "push", "-u", "origin", "main");
		}

		const info = await registerProject(dir);
		const row = repo.upsertProject(db, {
			repoPath: info.repoPath,
			name: proj.slug === "aurora" ? "Aurora" : "Atlas API",
			defaultBranch: info.defaultBranch,
		});
		if (!row) continue;

		for (const t of proj.tasks) {
			const created = await gitCreateTask({ repoPath: dir, name: t.name });
			if (t.changes) await write(created.worktreePath, t.changes);
			if (t.changes && t.commit) {
				git(created.worktreePath, "add", "-A");
				git(created.worktreePath, "commit", "-m", t.name);
			}
			repo.createTask(db, {
				projectId: row.id,
				name: t.name,
				slug: created.slug,
				branch: created.branch,
				baseBranch: created.baseBranch,
				worktreePath: created.worktreePath,
				column: t.column,
				agentId: t.agentId ?? null,
				agentStatus: t.agentStatus ?? null,
				prNumber: t.prNumber ?? null,
				prUrl: t.prNumber
					? `https://github.com/clawnify/${proj.slug}/pull/${t.prNumber}`
					: null,
				isUnread: t.isUnread ?? false,
				lastEventAt: Date.now() - Math.floor(1000 * 60 * (1 + 30 * Math.random())),
				gitStatus: {
					ahead: t.ahead ?? 0,
					behind: 0,
					dirty: t.dirty ?? 0,
					updatedAt: Date.now(),
				},
			});
		}
	}
}
