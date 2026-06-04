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
	name: string;
	files: Record<string, string>;
	tasks: DemoTask[];
}

const PROJECTS: DemoProject[] = [
	{
		slug: "aurora",
		name: "Aurora",
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
			"src/rollups.ts":
				'export function dailyRollup(events: Event[]) {\n  const day = new Date().toISOString().slice(0, 10)\n  return aggregate(events, day)\n}\n',
			"src/ui/settings.tsx":
				'export function Settings() {\n  return (\n    <section className="settings">\n      <h1>Settings</h1>\n      <ProfileForm />\n    </section>\n  )\n}\n',
			"src/flags.ts":
				'export const flags = {\n  newOnboarding: true,\n  legacyCharts: true,\n  betaExports: false,\n}\n',
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
				name: "Funnel step drag & drop",
				column: "running",
				agentId: "claude",
				agentStatus: "running",
				dirty: 2,
				changes: {
					"src/ui/funnel-dnd.tsx":
						'import { Reorder } from "motion/react"\n\nexport function FunnelSteps({ steps, onReorder }) {\n  return (\n    <Reorder.Group axis="y" values={steps} onReorder={onReorder}>\n      {steps.map((s) => (\n        <Reorder.Item key={s.id} value={s} />\n      ))}\n    </Reorder.Group>\n  )\n}\n',
				},
			},
			{
				name: "Upgrade to React 19",
				column: "running",
				agentId: "codex",
				agentStatus: "running",
				dirty: 1,
				changes: {
					"package.json":
						'{ "name": "aurora", "version": "2.5.0", "dependencies": { "react": "^19.0.0" } }\n',
				},
			},
			{
				name: "Annotate spikes on charts",
				column: "running",
				agentId: "claude",
				agentStatus: "running",
			},
			{
				name: "SSO with Okta (SAML)",
				column: "running",
				agentId: "claude",
				agentStatus: "running",
				dirty: 1,
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
				name: "Fix timezone bug in daily rollups",
				column: "needs_attention",
				agentId: "claude",
				agentStatus: "awaiting_input",
				isUnread: true,
				dirty: 1,
				changes: {
					"src/rollups.ts":
						'import { toZonedDay } from "./tz"\n\nexport function dailyRollup(events: Event[], tz: string) {\n  const day = toZonedDay(Date.now(), tz)\n  return aggregate(events, day)\n}\n',
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
					"src/ui/settings.tsx":
						'import { themes } from "./theme"\n\nexport function Settings() {\n  return (\n    <section className="settings" data-theme="dark">\n      <h1>Settings</h1>\n      <ThemeToggle themes={themes} />\n      <ProfileForm />\n    </section>\n  )\n}\n',
				},
			},
			{
				name: "Retention cohort heatmap",
				column: "review",
				agentId: "claude",
				agentStatus: "idle",
				prNumber: 45,
				isUnread: true,
				ahead: 3,
				commit: true,
				changes: {
					"src/ui/heatmap.tsx":
						'export function CohortHeatmap({ cohorts }) {\n  return (\n    <table className="heatmap">\n      {cohorts.map((c) => (\n        <Row key={c.week} cells={c.retention} />\n      ))}\n    </table>\n  )\n}\n',
				},
			},
			{
				name: "Event schema validation with zod",
				column: "review",
				agentId: "codex",
				agentStatus: "idle",
				prNumber: 44,
				ahead: 1,
				commit: true,
				changes: {
					"src/api/events.ts":
						'import { z } from "zod"\n\nconst Event = z.object({ name: z.string(), props: z.record(z.unknown()) })\n\nexport async function track(event: string, props: object) {\n  const parsed = Event.parse({ name: event, props })\n  await db.insert({ ...parsed, at: Date.now() })\n}\n',
				},
			},
			{
				name: "GDPR data deletion endpoint",
				column: "needs_attention",
				agentId: "claude",
				agentStatus: "awaiting_input",
				isUnread: true,
			},
			{
				name: "Weekly email digest",
				column: "review",
				agentId: "claude",
				agentStatus: "idle",
				prNumber: 47,
			},
			{ name: "Migrate billing to Postgres 16", column: "todo" },
			{ name: "Self-serve data export (CSV/Parquet)", column: "todo" },
			{
				name: "Prune stale feature flags",
				column: "todo",
				changes: {
					"src/flags.ts":
						'export const flags = {\n  betaExports: false,\n}\n',
				},
			},
			{
				name: "Refactor webhook retries",
				column: "merged",
				agentId: "claude",
				agentStatus: "idle",
				prNumber: 38,
			},
			{
				name: 'Rename "workspaces" to "projects"',
				column: "merged",
				agentId: "claude",
				agentStatus: "idle",
				prNumber: 36,
			},
		],
	},
	{
		slug: "atlas-api",
		name: "Atlas API",
		files: {
			"README.md": "# Atlas API\n\nGeospatial REST API for map tiles.\n",
			"src/server.ts":
				'import { createServer } from "./http"\n\ncreateServer().listen(8080)\n',
			"src/tiles.ts":
				"export async function tile(z: number, x: number, y: number) {\n  return render(z, x, y)\n}\n",
			"src/http.ts":
				'export function createServer() {\n  return new Server({ cors: true })\n}\n',
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
					"src/http.ts":
						'import { rateLimit } from "./middleware/rate-limit"\n\nexport function createServer() {\n  const s = new Server({ cors: true })\n  s.use(rateLimit)\n  return s\n}\n',
				},
			},
			{
				name: "Vector tiles endpoint",
				column: "running",
				agentId: "claude",
				agentStatus: "running",
				dirty: 2,
				changes: {
					"src/tiles.ts":
						'export async function tile(z: number, x: number, y: number) {\n  return render(z, x, y)\n}\n\nexport async function vectorTile(z: number, x: number, y: number) {\n  return encodeMVT(await features(z, x, y))\n}\n',
				},
			},
			{
				name: "Fix 500 on malformed bbox",
				column: "needs_attention",
				agentId: "claude",
				agentStatus: "awaiting_input",
				isUnread: true,
				dirty: 1,
				changes: {
					"src/server.ts":
						'import { createServer } from "./http"\nimport { validateBbox } from "./validate"\n\nconst app = createServer()\napp.use(validateBbox)\napp.listen(8080)\n',
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
			{
				name: "Cache tiles in R2",
				column: "review",
				agentId: "codex",
				agentStatus: "idle",
				prNumber: 9,
				ahead: 2,
				commit: true,
				changes: {
					"src/cache.ts":
						'export async function cached(key: string, render: () => Promise<Buffer>) {\n  const hit = await r2.get(key)\n  if (hit) return hit\n  const fresh = await render()\n  await r2.put(key, fresh, { ttl: 86_400 })\n  return fresh\n}\n',
				},
			},
			{
				name: "Geocoding batch endpoint",
				column: "running",
				agentId: "claude",
				agentStatus: "running",
			},
			{
				name: "S3 fallback when R2 is down",
				column: "needs_attention",
				agentId: "claude",
				agentStatus: "awaiting_input",
				isUnread: true,
			},
			{
				name: "Sharded tile render queue",
				column: "review",
				agentId: "codex",
				agentStatus: "idle",
				prNumber: 11,
			},
			{ name: "Terraform module for self-hosting", column: "todo" },
			{
				name: "Add Prometheus metrics",
				column: "merged",
				agentId: "claude",
				agentStatus: "idle",
				prNumber: 5,
			},
		],
	},
	{
		slug: "beacon",
		name: "Beacon",
		files: {
			"README.md": "# Beacon\n\nMobile companion app — alerts on the go.\n",
			"src/App.tsx":
				'export function App() {\n  return <Navigator initial="home" />\n}\n',
			"src/notifications.ts":
				"export function register() {\n  return Push.requestPermission()\n}\n",
		},
		tasks: [
			{
				name: "Push notifications for alerts",
				column: "running",
				agentId: "claude",
				agentStatus: "running",
				dirty: 1,
				changes: {
					"src/notifications.ts":
						'export async function register() {\n  const ok = await Push.requestPermission()\n  if (ok) await Push.subscribe("alerts")\n  return ok\n}\n',
				},
			},
			{
				name: "Offline mode with sync queue",
				column: "running",
				agentId: "claude",
				agentStatus: "running",
			},
			{
				name: "Fix keyboard overlap on iOS",
				column: "needs_attention",
				agentId: "codex",
				agentStatus: "awaiting_input",
				isUnread: true,
			},
			{
				name: "App icon + splash refresh",
				column: "review",
				agentId: "claude",
				agentStatus: "idle",
				prNumber: 12,
			},
			{
				name: "Deep links for alert detail",
				column: "review",
				agentId: "claude",
				agentStatus: "idle",
				prNumber: 14,
			},
			{ name: "Biometric unlock", column: "todo" },
			{
				name: "Crash on Android 15 back gesture",
				column: "merged",
				agentId: "claude",
				agentStatus: "idle",
				prNumber: 11,
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
			name: proj.name,
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
