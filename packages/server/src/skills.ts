// The skills an agent session can invoke, read from the folders that agent
// itself reads. Ateam keeps no skill store of its own: a second list would go
// stale against the agents' folders, and "which skills does this agent see?" is
// exactly the question people say they can no longer answer. Engine-side on
// purpose, like session search: a task on a box lists the box's skills.
//
// Each agent's discovery rule is replicated from its own source at the versions
// this was written against (Claude Code 2.1.316 docs, codex rust-v0.165.0
// `ext/skills/src/host_roots.rs` + `loader/`, opencode v1.18.34
// `src/skill/index.ts`). Claude Code has no command that lists skills, so a
// replica is the only route there; doing the same for all three keeps one code
// path with one table to update when an agent moves a folder.
//
// Linking (`linkSkill`) writes one symlink per agent folder. A symlink rather
// than a copy, so an edit at the source reaches the agents without a sync step:
// the "single source of truth" every skill manager converged on.
import { existsSync } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	readlink,
	realpath,
	stat,
	symlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { SkillDTO, SkillLinkResult, SkillScope } from "@ateam/protocol";

/** Where to look. `cwd` is the session's directory, `root` its worktree root. */
export interface SkillContext {
	cwd: string;
	root: string;
	home?: string;
	env?: NodeJS.ProcessEnv;
	now?: number;
	/** The terminal's own agent conversation, to count what was sent in it. */
	sessionId?: string | null;
}

/** What a SKILL.md (or a Claude command file) says about itself. */
interface Frontmatter {
	name?: string;
	description?: string;
	userInvocable?: boolean;
	/** Whether the file opened with a `---` block at all (Codex requires one). */
	present: boolean;
	/** First non-empty body line: Claude's description for a file without one. */
	firstLine: string;
}

/**
 * Just enough YAML for the fields every agent reads: `key: value`, quoted
 * values, and `>` / `|` block scalars. Malformed input yields what parsed, as
 * Claude Code does (it loads the body with empty metadata rather than failing).
 */
export function parseFrontmatter(text: string): Frontmatter {
	const lines = text.replace(/^﻿/, "").split(/\r?\n/);
	const out: Frontmatter = { present: false, firstLine: "" };
	let i = 0;
	const fields: Record<string, string> = {};
	if (lines[0]?.trim() === "---") {
		const end = lines.findIndex((l, n) => n > 0 && l.trim() === "---");
		if (end > 0) {
			out.present = true;
			for (i = 1; i < end; i++) {
				const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i] ?? "");
				if (!m) continue;
				const key = m[1] as string;
				let value = (m[2] ?? "").trim();
				if (value === ">" || value === "|" || /^[>|][+-]?$/.test(value)) {
					const folded = value.startsWith(">");
					const block: string[] = [];
					while (i + 1 < end && /^(\s+|$)/.test(lines[i + 1] ?? ""))
						block.push((lines[++i] ?? "").trim());
					value = block.join(folded ? " " : "\n").trim();
				} else if (/^".*"$/.test(value)) {
					try {
						value = JSON.parse(value) as string;
					} catch {
						value = value.slice(1, -1);
					}
				} else if (/^'.*'$/.test(value)) {
					value = value.slice(1, -1).replace(/''/g, "'");
				}
				fields[key] = value;
			}
			i = end + 1;
		} else {
			i = 0;
		}
	}
	for (; i < lines.length; i++) {
		const l = (lines[i] ?? "").trim();
		if (l) {
			out.firstLine = l.replace(/^#+\s*/, "");
			break;
		}
	}
	if (fields.name) out.name = fields.name;
	if (fields.description) out.description = fields.description;
	if (fields["user-invocable"] === "false") out.userInvocable = false;
	return out;
}

async function readText(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

async function isDir(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function entries(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch {
		return [];
	}
}

/** `<dir>/<name>/SKILL.md`, one level deep: Claude Code's layout. */
async function oneLevel(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const name of (await entries(dir)).sort()) {
		const file = join(dir, name, "SKILL.md");
		if (existsSync(file)) out.push(file);
	}
	return out;
}

/**
 * Every SKILL.md under `dir`, following symlinks, to `maxDepth` folders down.
 * A folder holding a SKILL.md is a skill and is not searched further (its own
 * scripts or node_modules are not more skills). Visited real paths guard
 * against symlink loops.
 */
async function recursive(
	dir: string,
	opts: { maxDepth: number; hidden: boolean },
	seen = new Set<string>(),
	depth = 0,
): Promise<string[]> {
	let real: string;
	try {
		real = await realpath(dir);
	} catch {
		return [];
	}
	if (seen.has(real)) return [];
	seen.add(real);
	const file = join(dir, "SKILL.md");
	if (existsSync(file)) return [file];
	if (depth >= opts.maxDepth) return [];
	const out: string[] = [];
	for (const name of (await entries(dir)).sort()) {
		if (name === "node_modules" || name === ".git") continue;
		if (!opts.hidden && name.startsWith(".")) continue;
		const child = join(dir, name);
		if (await isDir(child)) out.push(...(await recursive(child, opts, seen, depth + 1)));
	}
	return out;
}

/** Claude command files: `<dir>/**.md`, where `a/b.md` is `/a:b`. */
async function commandFiles(dir: string): Promise<{ file: string; name: string }[]> {
	const out: { file: string; name: string }[] = [];
	const walk = async (d: string, depth: number) => {
		for (const name of (await entries(d)).sort()) {
			const p = join(d, name);
			if (name.endsWith(".md") && !(await isDir(p))) {
				out.push({ file: p, name: relative(dir, p).slice(0, -3).split(sep).join(":") });
			} else if (depth < 3 && !name.startsWith(".") && (await isDir(p))) {
				await walk(p, depth + 1);
			}
		}
	};
	await walk(dir, 0);
	return out;
}

/** The session's folder and each parent up to the worktree root, nearest first. */
function upToRoot(cwd: string, root: string): string[] {
	const out: string[] = [];
	let d = resolve(cwd);
	const r = resolve(root);
	if (d !== r && !d.startsWith(r + sep)) return [r];
	for (;;) {
		out.push(d);
		if (d === r) break;
		const up = dirname(d);
		if (up === d) break;
		d = up;
	}
	return out;
}

interface Found {
	name: string;
	description: string;
	scope: SkillScope;
	path: string;
}

/** Read one SKILL.md into a candidate, applying the agent's validity rule. */
async function candidate(
	file: string,
	scope: SkillScope,
	rule: "claude" | "codex" | "opencode",
	prefix = "",
): Promise<Found | null> {
	const text = await readText(file);
	if (text === null) return null;
	const fm = parseFrontmatter(text);
	if (rule === "codex" && (!fm.present || !fm.description)) return null;
	if (rule === "opencode" && !fm.name) return null;
	if (rule === "claude" && fm.userInvocable === false) return null;
	const dirName = basename(dirname(file));
	const name =
		rule === "claude"
			? fm.name || dirName
			: rule === "codex"
				? fm.name || dirName
				: (fm.name as string);
	if (!/^[\w.:-]+$/.test(name)) return null;
	return {
		name: prefix + name,
		description: fm.description ?? (rule === "claude" ? fm.firstLine : ""),
		scope,
		path: file,
	};
}

async function claudeSkills(
	ctx: Required<Omit<SkillContext, "now" | "sessionId">>,
): Promise<Found[]> {
	const { home, cwd, root } = ctx;
	const claude = join(home, ".claude");
	const dirs = upToRoot(cwd, root);
	const out: Found[] = [];
	const add = (f: Found | null) => f && out.push(f);

	// Personal skills, then project skills: a personal skill wins a name clash.
	for (const f of await oneLevel(join(claude, "skills"))) {
		if (basename(dirname(f)) === "synced") continue;
		add(await candidate(f, "personal", "claude"));
	}
	for (const d of dirs)
		for (const f of await oneLevel(join(d, ".claude", "skills")))
			add(await candidate(f, "project", "claude"));

	// Enabled plugins, namespaced `plugin:skill`. A project-scoped install for this
	// worktree wins over the user-scoped one, the way Claude resolves them.
	const enabled = new Set<string>();
	for (const file of [join(claude, "settings.json"), join(root, ".claude", "settings.json")]) {
		try {
			const s = JSON.parse((await readText(file)) ?? "{}") as {
				enabledPlugins?: Record<string, boolean>;
			};
			for (const [k, on] of Object.entries(s.enabledPlugins ?? {})) {
				if (on) enabled.add(k);
				else enabled.delete(k);
			}
		} catch {
			/* a broken settings file enables nothing */
		}
	}
	type Install = { scope?: string; projectPath?: string; installPath?: string };
	let installed: Record<string, Install[]> = {};
	try {
		const raw = JSON.parse(
			(await readText(join(claude, "plugins", "installed_plugins.json"))) ?? "{}",
		) as {
			plugins?: Record<string, Install[]>;
		};
		installed = raw.plugins ?? {};
	} catch {
		/* no plugins */
	}
	for (const key of [...enabled].sort()) {
		const list = installed[key] ?? [];
		const pick =
			list.find(
				(e) => e.scope !== "user" && e.projectPath && dirs.includes(resolve(e.projectPath)),
			) ?? list.find((e) => e.scope === "user");
		if (!pick?.installPath) continue;
		const plugin = key.split("@")[0] as string;
		for (const f of await oneLevel(join(pick.installPath, "skills"))) {
			add(await candidate(f, "plugin", "claude", `${plugin}:`));
		}
		for (const c of await commandFiles(join(pick.installPath, "commands"))) {
			const fm = parseFrontmatter((await readText(c.file)) ?? "");
			if (fm.userInvocable === false) continue;
			out.push({
				name: `${plugin}:${c.name}`,
				description: fm.description ?? fm.firstLine,
				scope: "plugin",
				path: c.file,
			});
		}
	}

	// Legacy command files: a skill of the same name beats them.
	for (const base of [claude, ...dirs.map((d) => join(d, ".claude"))]) {
		for (const c of await commandFiles(join(base, "commands"))) {
			const fm = parseFrontmatter((await readText(c.file)) ?? "");
			if (fm.userInvocable === false) continue;
			out.push({
				name: c.name,
				description: fm.description ?? fm.firstLine,
				scope: "command",
				path: c.file,
			});
		}
	}

	// Skills synced from claude.ai, under their own namespace.
	for (const account of await entries(join(claude, "skills", "synced"))) {
		for (const f of await oneLevel(join(claude, "skills", "synced", account))) {
			add(await candidate(f, "personal", "claude", "anthropic-skills:"));
		}
	}
	return out;
}

async function codexSkills(
	ctx: Required<Omit<SkillContext, "now" | "sessionId">>,
): Promise<Found[]> {
	const { home, cwd, root, env } = ctx;
	const codexHome = env.CODEX_HOME || join(home, ".codex");
	// Repo roots run from the project root down to the session's folder.
	const repoDirs = upToRoot(cwd, root).reverse();
	const roots: [string, SkillScope][] = [
		...repoDirs.flatMap((d): [string, SkillScope][] => [
			[join(d, ".codex", "skills"), "project"],
			[join(d, ".agents", "skills"), "project"],
		]),
		[join(codexHome, "skills"), "personal"],
		[join(home, ".agents", "skills"), "personal"],
		[join(codexHome, "skills", ".system"), "system"],
		["/etc/codex/skills", "system"],
	];
	// Plugins enabled in config.toml (`[plugins."greybeard@greybeard"]`), installed
	// under plugins/cache/<marketplace>/<plugin>/<version>; the newest version
	// folder is the installed one. Their skills are `plugin:skill`, like Claude's.
	const plugins: [string, string][] = [];
	const toml = (await readText(join(codexHome, "config.toml"))) ?? "";
	for (const m of toml.matchAll(/^\[plugins\."([^"]+)"\]\s*\n((?:(?!\[).*\n?)*)/gm)) {
		if (/^\s*enabled\s*=\s*false/m.test(m[2] ?? "")) continue;
		const [plugin, market] = (m[1] as string).split("@");
		if (!plugin || !market) continue;
		const base = join(codexHome, "plugins", "cache", market, plugin);
		let newest: [string, number] | null = null;
		for (const v of await entries(base)) {
			const st = await stat(join(base, v)).catch(() => null);
			if (st?.isDirectory() && (!newest || st.mtimeMs > newest[1]))
				newest = [join(base, v), st.mtimeMs];
		}
		if (newest) plugins.push([plugin, newest[0]]);
	}

	const out: Found[] = [];
	const seenFiles = new Set<string>();
	for (const [plugin, dir] of plugins) {
		for (const f of await oneLevel(join(dir, "skills"))) {
			const c = await candidate(f, "plugin", "codex", `${plugin}:`);
			if (c) out.push(c);
		}
	}
	for (const [dir, scope] of roots) {
		for (const f of await recursive(dir, { maxDepth: 6, hidden: false })) {
			// Codex dedupes by the canonical SKILL.md path, so one skill reached
			// through two symlinked folders is one skill.
			const real = await realpath(f).catch(() => f);
			if (seenFiles.has(real)) continue;
			seenFiles.add(real);
			const c = await candidate(f, scope, "codex");
			if (c) out.push(c);
		}
	}
	return out;
}

async function opencodeSkills(
	ctx: Required<Omit<SkillContext, "now" | "sessionId">>,
): Promise<Found[]> {
	const { home, cwd, root, env } = ctx;
	const dirs = upToRoot(cwd, root);
	const external = !env.OPENCODE_DISABLE_EXTERNAL_SKILLS;
	const claudeOn =
		external && !env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS && !env.OPENCODE_DISABLE_CLAUDE_CODE;
	const configDir = env.XDG_CONFIG_HOME
		? join(env.XDG_CONFIG_HOME, "opencode")
		: join(home, ".config", "opencode");
	const roots: [string, SkillScope, boolean][] = [];
	if (claudeOn) roots.push([join(home, ".claude", "skills"), "personal", true]);
	if (external) roots.push([join(home, ".agents", "skills"), "personal", true]);
	for (const d of dirs) {
		if (claudeOn) roots.push([join(d, ".claude", "skills"), "project", true]);
		if (external) roots.push([join(d, ".agents", "skills"), "project", true]);
	}
	for (const sub of ["skill", "skills"]) roots.push([join(configDir, sub), "personal", false]);
	for (const d of dirs)
		for (const sub of ["skill", "skills"])
			roots.push([join(d, ".opencode", sub), "project", false]);
	const out: Found[] = [];
	for (const [dir, scope, hidden] of roots) {
		for (const f of await recursive(dir, { maxDepth: 6, hidden })) {
			const c = await candidate(f, scope, "opencode");
			if (c) out.push(c);
		}
	}
	// Bundled in the binary; a skill on disk with its name replaces it.
	out.push({
		name: "customize-opencode",
		description: "Use ONLY when the user is editing or creating opencode's own configuration.",
		scope: "system",
		path: "<built-in>",
	});
	return out;
}

// ---- usage: what the user actually types, from the agent's own prompt history ----

const USAGE_DAYS = 30;
const USAGE_TTL_MS = 5 * 60_000;
const usageCache = new Map<string, { at: number; counts: Map<string, number> }>();

/**
 * How often each `/name` (or Codex `$name`) was typed in the last 30 days,
 * from the prompt history the agent keeps for its own ↑ recall: small files,
 * unlike the transcripts (gigabytes a month). OpenCode's history has no
 * timestamps, so all of it counts.
 */
export async function typedCommands(
	agentId: string,
	home: string,
	env: NodeJS.ProcessEnv,
	now = Date.now(),
): Promise<Map<string, number>> {
	const key = `${agentId}:${home}`;
	const hit = usageCache.get(key);
	if (hit && now - hit.at < USAGE_TTL_MS) return hit.counts;
	const cutoff = now - USAGE_DAYS * 86_400_000;
	const counts = new Map<string, number>();
	const bump = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1);
	const each = async (file: string, fn: (e: Record<string, unknown>) => void) => {
		const text = await readText(file);
		if (!text) return;
		for (const line of text.split("\n")) {
			if (!line) continue;
			try {
				fn(JSON.parse(line) as Record<string, unknown>);
			} catch {
				/* a torn last line */
			}
		}
	};
	const slash = /^\/([\w.:-]+)/;
	if (agentId === "claude") {
		await each(join(home, ".claude", "history.jsonl"), (e) => {
			if (typeof e.timestamp !== "number" || e.timestamp < cutoff) return;
			const m = slash.exec(String(e.display ?? "").trim());
			if (m) bump(m[1] as string);
		});
	} else if (agentId === "codex") {
		await each(join(env.CODEX_HOME || join(home, ".codex"), "history.jsonl"), (e) => {
			if (typeof e.ts !== "number" || e.ts * 1000 < cutoff) return;
			for (const m of String(e.text ?? "").matchAll(/\$([A-Za-z0-9_:-]+)/g)) bump(m[1] as string);
		});
	} else if (agentId === "opencode") {
		const state = env.XDG_STATE_HOME || join(home, ".local", "state");
		await each(join(state, "opencode", "prompt-history.jsonl"), (e) => {
			const m = slash.exec(String(e.input ?? "").trim());
			if (m) bump(m[1] as string);
		});
	}
	usageCache.set(key, { at: now, counts });
	return counts;
}

// ---- this session: what was sent in the terminal's own conversation ----

/** Transcript path per agent conversation id, found once: it never moves. */
const transcriptPaths = new Map<string, string>();

/**
 * Where the agent writes this conversation: Claude Code at
 * ~/.claude/projects/<dir>/<id>.jsonl (the dir is found by looking, not by
 * re-deriving Claude's undocumented cwd slug), Codex at
 * sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, newest days first. OpenCode
 * keeps its sessions in SQLite under an id Ateam is never told, so none.
 */
async function findTranscript(
	agentId: string,
	sessionId: string,
	home: string,
	env: NodeJS.ProcessEnv,
): Promise<string | null> {
	const key = `${agentId}:${sessionId}`;
	const known = transcriptPaths.get(key);
	if (known && existsSync(known)) return known;
	let found: string | null = null;
	if (agentId === "claude") {
		const root = join(home, ".claude", "projects");
		for (const dir of await entries(root)) {
			const p = join(root, dir, `${sessionId}.jsonl`);
			if (existsSync(p)) {
				found = p;
				break;
			}
		}
	} else if (agentId === "codex") {
		const root = join(env.CODEX_HOME || join(home, ".codex"), "sessions");
		const desc = async (d: string) => (await entries(d)).sort().reverse();
		search: for (const y of await desc(root))
			for (const m of await desc(join(root, y)))
				for (const d of await desc(join(root, y, m)))
					for (const f of await entries(join(root, y, m, d)))
						if (f.endsWith(`-${sessionId}.jsonl`)) {
							found = join(root, y, m, d, f);
							break search;
						}
	}
	if (found) transcriptPaths.set(key, found);
	return found;
}

/** Commands counted so far per transcript, and how far it has been read. */
const sessionTallies = new Map<
	string,
	{ size: number; rest: string; counts: Map<string, number> }
>();

/**
 * The commands the user sent in one transcript line. Claude Code writes each
 * typed slash command or skill as a user message holding
 * `<command-name>/name</command-name>`; Codex keeps the typed text, `$name`
 * mentions and all, as a user message after the instructions it injects
 * itself (AGENTS.md, environment context, skill bodies, all opening with `<`
 * or a heading), which are skipped.
 */
function commandsInLine(agentId: string, line: string): string[] {
	if (agentId === "claude") {
		if (!line.includes("<command-name>") || !line.includes('"type":"user"')) return [];
		try {
			const e = JSON.parse(line) as {
				type?: string;
				isMeta?: boolean;
				isSidechain?: boolean;
				message?: { content?: unknown };
			};
			if (e.type !== "user" || e.isMeta || e.isSidechain) return [];
			const c = e.message?.content;
			const text = typeof c === "string" ? c : JSON.stringify(c ?? "");
			return [...text.matchAll(/<command-name>\/([\w.:-]+)<\/command-name>/g)].map(
				(m) => m[1] as string,
			);
		} catch {
			return [];
		}
	}
	if (agentId === "codex") {
		if (!line.includes('"role":"user"') || !line.includes("$")) return [];
		try {
			const e = JSON.parse(line) as { payload?: { role?: string; content?: { text?: string }[] } };
			if (e.payload?.role !== "user") return [];
			const text = (e.payload.content ?? []).map((c) => c?.text ?? "").join("");
			if (/^\s*(<|# AGENTS\.md)/.test(text)) return [];
			return [...text.matchAll(/(?:^|\s)\$([A-Za-z0-9_:-]+)/g)].map((m) => m[1] as string);
		} catch {
			return [];
		}
	}
	return [];
}

/**
 * How many times each command was sent in this conversation. Transcripts only
 * grow, so each call reads just the bytes added since the last one (a long
 * session's file runs to tens of MB); a file that shrank is counted afresh.
 */
export async function sessionCommands(
	agentId: string,
	sessionId: string,
	opts: { home?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<Map<string, number>> {
	const path = await findTranscript(
		agentId,
		sessionId,
		opts.home ?? homedir(),
		opts.env ?? process.env,
	);
	if (!path) return new Map();
	const size = (await stat(path).catch(() => null))?.size ?? 0;
	let t = sessionTallies.get(path);
	if (!t || size < t.size) t = { size: 0, rest: "", counts: new Map() };
	if (size > t.size) {
		const fh = await open(path, "r");
		try {
			const buf = Buffer.alloc(size - t.size);
			await fh.read(buf, 0, buf.length, t.size);
			const lines = (t.rest + buf.toString("utf8")).split("\n");
			t.rest = lines.pop() ?? "";
			for (const line of lines) {
				for (const name of commandsInLine(agentId, line))
					t.counts.set(name, (t.counts.get(name) ?? 0) + 1);
			}
			t.size = size;
		} finally {
			await fh.close();
		}
	}
	sessionTallies.set(path, t);
	return t.counts;
}

const PREFIX: Record<string, string> = { claude: "/", codex: "$", opencode: "/" };

/**
 * The skills the given agent would offer in a session at `ctx.cwd`, one entry
 * per name (the first by that agent's precedence), most typed first, then by
 * name. Unknown agents and shells have none.
 */
export async function listSkills(agentId: string, ctx: SkillContext): Promise<SkillDTO[]> {
	const prefix = PREFIX[agentId];
	if (!prefix) return [];
	const full = {
		cwd: ctx.cwd,
		root: ctx.root,
		home: ctx.home ?? homedir(),
		env: ctx.env ?? process.env,
	};
	const found =
		agentId === "claude"
			? await claudeSkills(full)
			: agentId === "codex"
				? await codexSkills(full)
				: await opencodeSkills(full);
	const byName = new Map<string, Found>();
	for (const f of found) if (!byName.has(f.name)) byName.set(f.name, f);

	const typed = await typedCommands(agentId, full.home, full.env, ctx.now);
	const sent = ctx.sessionId
		? await sessionCommands(agentId, ctx.sessionId, full)
		: new Map<string, number>();
	// Claude also runs a plugin skill typed without its namespace when no other
	// skill claims the bare name, and people do type it that way.
	const bare = new Map<string, number>();
	for (const name of byName.keys()) {
		const short = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
		bare.set(short, (bare.get(short) ?? 0) + 1);
	}
	const countOf = (counts: Map<string, number>, name: string) => {
		const short = name.slice(name.lastIndexOf(":") + 1);
		const viaBare =
			name !== short && !byName.has(short) && bare.get(short) === 1 ? (counts.get(short) ?? 0) : 0;
		return (counts.get(name) ?? 0) + viaBare;
	};
	const skills: SkillDTO[] = [...byName.values()].map((f) => ({
		name: f.name,
		command: `${prefix}${f.name}`,
		description: f.description.length > 300 ? `${f.description.slice(0, 297)}…` : f.description,
		scope: f.scope,
		path: f.path,
		uses: countOf(typed, f.name),
		sessionUses: countOf(sent, f.name),
	}));
	return skills.sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
}

// ---- linking a skill into the agents' folders ----

/** Claude reads ~/.claude/skills; Codex, OpenCode and Cursor read ~/.agents/skills. */
const LINK_DIRS = [
	[".claude", "skills"],
	[".agents", "skills"],
] as const;

/**
 * Link the skill at `source` (its folder, or its SKILL.md) into every agent's
 * personal skills folder as a symlink. Folders that are the same place on disk
 * (here ~/.agents/skills is often a link to ~/.claude/skills) get one link.
 * Refuses rather than replaces when the name is already taken by a different
 * skill. `dryRun` reports the plan, including where each link really lands, so
 * the user can see it before anything is written.
 */
export async function linkSkill(
	source: string,
	opts: { home?: string; dryRun?: boolean } = {},
): Promise<SkillLinkResult> {
	const home = opts.home ?? homedir();
	let dir = resolve(source);
	if (basename(dir) === "SKILL.md") dir = dirname(dir);
	const file = join(dir, "SKILL.md");
	const text = await readText(file);
	if (text === null)
		throw new Error(`No SKILL.md in ${dir}. Pick the folder that holds the skill's SKILL.md.`);
	const fm = parseFrontmatter(text);
	const name = fm.name || basename(dir);
	if (!/^[\w.-]+$/.test(name))
		throw new Error(`"${name}" can't be a skill folder name (letters, digits, . _ - only).`);
	const realSource = await realpath(dir);

	const links: SkillLinkResult["links"] = [];
	const seen = new Set<string>();
	for (const parts of LINK_DIRS) {
		const parent = join(home, ...parts);
		const realParent = await realpath(parent).catch(() => parent);
		if (seen.has(realParent)) continue;
		seen.add(realParent);
		const path = join(parent, name);
		let status: "create" | "exists" = "create";
		const st = await lstat(path).catch(() => null);
		if (st) {
			const target = await realpath(path).catch(() => null);
			if (target !== realSource) {
				const where = st.isSymbolicLink() ? ` (a link to ${await readlink(path)})` : "";
				throw new Error(
					`A skill named "${name}" already exists at ${path}${where}. Rename or remove it first.`,
				);
			}
			status = "exists";
		}
		links.push({ path, realDir: realParent, status });
	}
	if (!opts.dryRun) {
		for (const l of links) {
			if (l.status === "exists") continue;
			await mkdir(dirname(l.path), { recursive: true });
			await symlink(realSource, l.path, "dir");
		}
	}
	return { name, source: realSource, description: fm.description ?? "", links };
}
