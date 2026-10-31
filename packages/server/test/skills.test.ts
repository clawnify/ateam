import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { linkSkill, listSkills, parseFrontmatter } from "../src/skills";

let home: string;
let repo: string;

const write = (path: string, text: string) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
};
const skill = (dir: string, name: string, description = `${name} does a thing`, extra = "") =>
	write(
		join(dir, name, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nBody of ${name}.\n`,
	);
const names = (xs: { name: string }[]) => xs.map((x) => x.name).sort();

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "ateam-skills-home-")));
	repo = realpathSync(mkdtempSync(join(tmpdir(), "ateam-skills-repo-")));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

describe("parseFrontmatter", () => {
	test("quoted, folded and plain values", () => {
		const fm = parseFrontmatter(
			'---\nname: wrap\ndescription: "Rule on it: finish now"\nargument-hint: [x]\n---\n# Title\n',
		);
		expect(fm).toMatchObject({
			name: "wrap",
			description: "Rule on it: finish now",
			present: true,
			firstLine: "Title",
		});
		const folded = parseFrontmatter(
			"---\nname: a\ndescription: >\n  one\n  two\nuser-invocable: false\n---\n",
		);
		expect(folded.description).toBe("one two");
		expect(folded.userInvocable).toBe(false);
	});
	test("no frontmatter: the first body line stands in", () => {
		expect(parseFrontmatter("Merge the branch.\n\nSteps:")).toMatchObject({
			present: false,
			firstLine: "Merge the branch.",
		});
	});
});

describe("listSkills: claude", () => {
	test("personal, project, plugin, commands and synced skills, each invoked with /", async () => {
		skill(join(home, ".claude", "skills"), "research-topic");
		skill(join(home, ".claude", "skills"), "hidden", "x", "user-invocable: false\n");
		skill(join(repo, ".claude", "skills"), "project-only");
		write(join(home, ".claude", "commands", "merge.md"), "Merge the current branch via GitHub.\n");
		write(
			join(home, ".claude", "commands", "frontend", "lint.md"),
			"---\ndescription: Lint it\n---\n",
		);
		skill(join(home, ".claude", "skills", "synced", "acct"), "docx");
		const install = join(home, ".claude", "plugins", "cache", "greybeard", "abc");
		skill(join(install, "skills"), "pressure-test");
		write(
			join(home, ".claude", "settings.json"),
			JSON.stringify({ enabledPlugins: { "greybeard@greybeard": true, "off@x": false } }),
		);
		write(
			join(home, ".claude", "plugins", "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: { "greybeard@greybeard": [{ scope: "user", installPath: install }] },
			}),
		);

		const skills = await listSkills("claude", { cwd: repo, root: repo, home, env: {} });
		expect(names(skills)).toEqual([
			"anthropic-skills:docx",
			"frontend:lint",
			"greybeard:pressure-test",
			"merge",
			"project-only",
			"research-topic",
		]);
		const merge = skills.find((s) => s.name === "merge");
		expect(merge).toMatchObject({
			command: "/merge",
			scope: "command",
			description: "Merge the current branch via GitHub.",
		});
		expect(skills.find((s) => s.name === "greybeard:pressure-test")?.command).toBe(
			"/greybeard:pressure-test",
		);
	});

	test("a personal skill beats a project one and a command of the same name", async () => {
		skill(join(home, ".claude", "skills"), "deploy", "personal");
		skill(join(repo, ".claude", "skills"), "deploy", "project");
		write(join(home, ".claude", "commands", "deploy.md"), "command\n");
		const skills = await listSkills("claude", { cwd: repo, root: repo, home, env: {} });
		expect(skills).toHaveLength(1);
		expect(skills[0]).toMatchObject({ description: "personal", scope: "personal" });
	});

	test("usage from the prompt history ranks skills, counting a plugin skill typed without its namespace", async () => {
		skill(join(home, ".claude", "skills"), "research-topic");
		skill(join(home, ".claude", "skills"), "humanize-writing");
		const install = join(home, "plug");
		skill(join(install, "skills"), "pressure-test");
		write(
			join(home, ".claude", "settings.json"),
			JSON.stringify({ enabledPlugins: { "greybeard@g": true } }),
		);
		write(
			join(home, ".claude", "plugins", "installed_plugins.json"),
			JSON.stringify({ plugins: { "greybeard@g": [{ scope: "user", installPath: install }] } }),
		);
		const now = Date.UTC(2026, 9, 31);
		const day = 86_400_000;
		const lines = [
			{ display: "/research-topic x", timestamp: now - day },
			{ display: "/greybeard:pressure-test", timestamp: now - day },
			{ display: "/pressure-test the plan", timestamp: now - 2 * day },
			{ display: "/pressure-test", timestamp: now - 2 * day },
			{ display: "/research-topic old", timestamp: now - 40 * day },
			{ display: "no command", timestamp: now },
		];
		write(
			join(home, ".claude", "history.jsonl"),
			`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
		);
		// A distinct home per test keeps the usage cache from leaking across tests.
		const skills = await listSkills("claude", { cwd: repo, root: repo, home, env: {}, now });
		expect(skills.map((s) => [s.name, s.uses])).toEqual([
			["greybeard:pressure-test", 3],
			["research-topic", 1],
			["humanize-writing", 0],
		]);
	});

	test("a session in a subfolder also sees project skills of the folders above it, up to the worktree root", async () => {
		const outer = realpathSync(mkdtempSync(join(tmpdir(), "ateam-skills-outer-")));
		const root = join(outer, "repo");
		skill(join(outer, ".claude", "skills"), "outside-root");
		skill(join(root, ".claude", "skills"), "root-skill");
		skill(join(root, "apps", "web", ".claude", "skills"), "web-skill");
		const skills = await listSkills("claude", {
			cwd: join(root, "apps", "web"),
			root,
			home,
			env: {},
		});
		expect(names(skills)).toEqual(["root-skill", "web-skill"]);
		rmSync(outer, { recursive: true, force: true });
	});
});

describe("listSkills: codex", () => {
	test("reads ~/.agents/skills and repo .agents/skills, needs a description, invokes with $", async () => {
		skill(join(home, ".agents", "skills"), "research-topic");
		write(join(home, ".agents", "skills", "no-desc", "SKILL.md"), "---\nname: no-desc\n---\n");
		write(join(home, ".agents", "skills", "no-fm", "SKILL.md"), "Just a body\n");
		skill(join(repo, ".agents", "skills", "group"), "nested");
		skill(join(home, ".claude", "skills"), "claude-only");
		const skills = await listSkills("codex", { cwd: repo, root: repo, home, env: {} });
		expect(names(skills)).toEqual(["nested", "research-topic"]);
		expect(skills.find((s) => s.name === "research-topic")?.command).toBe("$research-topic");
	});

	test("skills of a plugin enabled in config.toml are namespaced plugin:skill", async () => {
		const cache = join(home, ".codex", "plugins", "cache", "greybeard", "greybeard", "local");
		skill(join(cache, "skills"), "wrap");
		skill(join(home, ".codex", "plugins", "cache", "m", "off", "1", "skills"), "nope");
		write(
			join(home, ".codex", "config.toml"),
			'[plugins."greybeard@greybeard"]\nenabled = true\n\n[plugins."off@m"]\nenabled = false\n\n[tui]\nx = 1\n',
		);
		const skills = await listSkills("codex", { cwd: repo, root: repo, home, env: {} });
		expect(skills.map((s) => s.command)).toEqual(["$greybeard:wrap"]);
	});

	test("one skill reached through two symlinked folders is listed once", async () => {
		skill(join(home, ".claude", "skills"), "boxd-cli");
		mkdirSync(join(home, ".agents"), { recursive: true });
		symlinkSync(join(home, ".claude", "skills"), join(home, ".agents", "skills"));
		mkdirSync(join(home, ".codex", "skills"), { recursive: true });
		symlinkSync(
			join(home, ".claude", "skills", "boxd-cli"),
			join(home, ".codex", "skills", "boxd-cli"),
		);
		const skills = await listSkills("codex", { cwd: repo, root: repo, home, env: {} });
		expect(names(skills)).toEqual(["boxd-cli"]);
	});
});

describe("listSkills: opencode", () => {
	test("reads Claude's and the shared folders plus its own, needs a name, invokes with /", async () => {
		skill(join(home, ".claude", "skills"), "from-claude");
		skill(join(home, ".agents", "skills"), "from-agents");
		skill(join(home, ".config", "opencode", "skills"), "own");
		skill(join(repo, ".opencode", "skill"), "project-own");
		write(join(home, ".claude", "skills", "nameless", "SKILL.md"), "---\ndescription: d\n---\n");
		const skills = await listSkills("opencode", { cwd: repo, root: repo, home, env: {} });
		expect(names(skills)).toEqual([
			"customize-opencode",
			"from-agents",
			"from-claude",
			"own",
			"project-own",
		]);
		expect(skills.every((s) => s.command === `/${s.name}`)).toBe(true);
	});

	test("its switches turn the Claude folders off", async () => {
		skill(join(home, ".claude", "skills"), "from-claude");
		skill(join(home, ".agents", "skills"), "from-agents");
		const skills = await listSkills("opencode", {
			cwd: repo,
			root: repo,
			home,
			env: { OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" },
		});
		expect(names(skills)).toEqual(["customize-opencode", "from-agents"]);
	});
});

test("a shell or an unknown agent has no skills", async () => {
	skill(join(home, ".claude", "skills"), "x");
	expect(await listSkills("shell", { cwd: repo, root: repo, home, env: {} })).toEqual([]);
});

describe("linkSkill", () => {
	test("links into ~/.claude/skills and ~/.agents/skills; a dry run writes nothing", async () => {
		skill(repo, "my-skill");
		const source = join(repo, "my-skill");
		const plan = await linkSkill(join(source, "SKILL.md"), { home, dryRun: true });
		expect(plan.name).toBe("my-skill");
		expect(plan.links.map((l) => [l.path, l.status])).toEqual([
			[join(home, ".claude", "skills", "my-skill"), "create"],
			[join(home, ".agents", "skills", "my-skill"), "create"],
		]);
		expect(existsSync(join(home, ".claude"))).toBe(false);

		await linkSkill(source, { home });
		expect(readlinkSync(join(home, ".claude", "skills", "my-skill"))).toBe(source);
		expect(readlinkSync(join(home, ".agents", "skills", "my-skill"))).toBe(source);
		// Linking again is a no-op, not a conflict.
		const again = await linkSkill(source, { home });
		expect(again.links.every((l) => l.status === "exists")).toBe(true);
	});

	test("one link when ~/.agents/skills is the same folder as ~/.claude/skills, and it names the real folder", async () => {
		const dotfiles = join(home, "dotfiles", "claude", "skills");
		mkdirSync(dotfiles, { recursive: true });
		mkdirSync(join(home, ".claude"), { recursive: true });
		symlinkSync(dotfiles, join(home, ".claude", "skills"));
		mkdirSync(join(home, ".agents"), { recursive: true });
		symlinkSync("../.claude/skills", join(home, ".agents", "skills"));
		skill(repo, "my-skill");
		const res = await linkSkill(join(repo, "my-skill"), { home });
		expect(res.links).toEqual([
			{ path: join(home, ".claude", "skills", "my-skill"), realDir: dotfiles, status: "create" },
		]);
		expect(existsSync(join(dotfiles, "my-skill", "SKILL.md"))).toBe(true);
	});

	test("refuses a name another skill holds, and a folder with no SKILL.md", async () => {
		skill(join(home, ".claude", "skills"), "my-skill", "the existing one");
		skill(repo, "my-skill");
		await expect(linkSkill(join(repo, "my-skill"), { home })).rejects.toThrow(/already exists/);
		mkdirSync(join(repo, "empty"));
		await expect(linkSkill(join(repo, "empty"), { home })).rejects.toThrow(/No SKILL.md/);
	});
});

describe("sessionCommands: what was sent in this conversation", () => {
	const claudeLine = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
	const typed = (cmd: string, extra: Record<string, unknown> = {}) =>
		claudeLine({
			type: "user",
			message: {
				role: "user",
				content: `<command-message>${cmd}</command-message>\n<command-name>/${cmd}</command-name>`,
			},
			...extra,
		});

	test("claude: counts typed commands in that session's transcript only, and reads only what was appended", async () => {
		const dir = join(home, ".claude", "projects", "-some-worktree");
		const file = join(dir, "sess-1.jsonl");
		write(join(dir, "other.jsonl"), typed("research-topic"));
		write(
			file,
			typed("greybeard:pressure-test") +
				// The harness's own expansion of it, and a subagent's turn: not the user's.
				typed("greybeard:pressure-test", { isMeta: true }) +
				typed("research-topic", { isSidechain: true }) +
				claudeLine({
					type: "api-request-blob",
					message: { content: "<command-name>/merge</command-name>" },
				}) +
				claudeLine({ type: "user", message: { content: "just a prompt" } }),
		);
		skill(join(home, ".claude", "skills"), "research-topic");
		const install = join(home, "plug");
		skill(join(install, "skills"), "pressure-test");
		write(
			join(home, ".claude", "settings.json"),
			JSON.stringify({ enabledPlugins: { "greybeard@g": true } }),
		);
		write(
			join(home, ".claude", "plugins", "installed_plugins.json"),
			JSON.stringify({ plugins: { "greybeard@g": [{ scope: "user", installPath: install }] } }),
		);
		const ctx = { cwd: repo, root: repo, home, env: {}, sessionId: "sess-1" };
		const first = await listSkills("claude", ctx);
		expect(first.map((s) => [s.name, s.sessionUses])).toEqual([
			["greybeard:pressure-test", 1],
			["research-topic", 0],
		]);

		// The user sends two more, one typed without the plugin's namespace.
		const { appendFileSync } = await import("node:fs");
		appendFileSync(file, typed("research-topic") + typed("pressure-test"));
		const second = await listSkills("claude", ctx);
		expect(second.map((s) => [s.name, s.sessionUses])).toEqual([
			["greybeard:pressure-test", 2],
			["research-topic", 1],
		]);
	});

	test("codex: counts $mentions the user typed, not the instructions Codex injects", async () => {
		const day = join(home, ".codex", "sessions", "2026", "10", "31");
		const msg = (text: string) =>
			`${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } })}\n`;
		write(
			join(day, "rollout-2026-10-31T10-00-00-thread-9.jsonl"),
			msg("# AGENTS.md instructions\nuse $research-topic for research") +
				msg('<skill name="research-topic">body mentioning $research-topic</skill>') +
				msg("$research-topic what do people pay for X") +
				msg("then $research-topic again, and ignore $HOME"),
		);
		skill(join(home, ".agents", "skills"), "research-topic");
		const skills = await listSkills("codex", {
			cwd: repo,
			root: repo,
			home,
			env: {},
			sessionId: "thread-9",
		});
		expect(skills.map((s) => [s.name, s.sessionUses])).toEqual([["research-topic", 2]]);
	});

	test("no conversation id, or no transcript for it: nothing counted", async () => {
		skill(join(home, ".claude", "skills"), "research-topic");
		const none = await listSkills("claude", { cwd: repo, root: repo, home, env: {} });
		const missing = await listSkills("claude", {
			cwd: repo,
			root: repo,
			home,
			env: {},
			sessionId: "nope",
		});
		expect([none[0]?.sessionUses, missing[0]?.sessionUses]).toEqual([0, 0]);
	});
});
