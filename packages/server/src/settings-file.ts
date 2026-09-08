// User settings live in a hand-editable JSON file, not in the engine's SQLite.
//
// The `settings` table keeps what the ENGINE writes about its own machine
// (`hookPort`, `loginPath`): runtime cache no human should edit. What a human
// chooses belongs in a file they can read, grep, diff and sync with their
// dotfiles — the same split VS Code makes between settings.json and workspace
// storage, and the shape Herdr, Cursor and Claude Code all converged on
// (`~/.config/herdr/config.toml`, `~/.cursor/cli-config.json`,
// `~/.claude/settings.json`).
//
// One schema, one path, two readers. `client` keys are read by the desktop on
// the Mac running it (presentation, updates); `engine` keys are read by whichever
// engine runs the work, so on a box they come from the box's own file. That is
// Herdr's client/server split, and it is what makes a font a property of your
// Mac rather than of the box you happen to run a task on.
//
// Only keys with a reader exist here. A setting nothing reads is a lie in the
// file, and the schema's own `terminal_font_*` / `notifications_muted` columns
// (never read, never written outside tests) are the cautionary example.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AteamSettings, ClientSettings, EngineSettings, SettingsPatch } from "@ateam/protocol";

/** Bumped when the shape changes incompatibly, so a reader can migrate. */
export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS: AteamSettings = {
	version: SETTINGS_VERSION,
	client: {
		autoDownloadUpdates: false,
	},
	engine: {
		defaultAgentId: "claude",
		defaultMergeStrategy: "squash",
		defaultUpdateStrategy: "merge",
		deleteRemoteBranchOnMerge: false,
	},
};

/**
 * `~/.ateam/settings.json` on every machine, desktop and box alike — NOT the
 * engine's data dir. The data dir is where machine state lives (the db, hooks,
 * sockets) and on the desktop it is Application Support, which nobody symlinks
 * into a dotfiles repo. `ATEAM_CONFIG` overrides it, as `HERDR_CONFIG_PATH` and
 * `CURSOR_CONFIG_DIR` do for theirs.
 */
export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.ATEAM_CONFIG ?? join(homedir(), ".ateam", "settings.json");
}

export interface ReadSettingsResult {
	settings: AteamSettings;
	/**
	 * Set when the file could not be used as written. The settings returned are
	 * then the defaults, and the file itself was left alone (a broken one is
	 * renamed to `.bad` so the next write cannot clobber a hand edit someone
	 * meant to keep). Callers surface this; a silent fallback would let an
	 * edit vanish without a trace.
	 */
	warning?: string;
}

/**
 * Read settings, filling anything missing from the defaults — so a file that
 * only sets one key, or one written by an older version, still yields a full
 * object. An absent file is the ordinary first-run case, not a warning.
 */
export function readSettings(path: string = settingsPath()): ReadSettingsResult {
	if (!existsSync(path)) return { settings: structuredClone(DEFAULT_SETTINGS) };
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		const bad = `${path}.bad`;
		try {
			renameSync(path, bad);
		} catch {
			/* leave it; the warning still says what happened */
		}
		return {
			settings: structuredClone(DEFAULT_SETTINGS),
			warning: `${path} is not valid JSON (${(err as Error).message}); using defaults. The file was moved to ${bad}.`,
		};
	}
	if (!isRecord(raw)) {
		return {
			settings: structuredClone(DEFAULT_SETTINGS),
			warning: `${path} should hold a JSON object; using defaults.`,
		};
	}
	return { settings: merge(raw) };
}

/**
 * Write a patch over the current file, atomically (tmp + rename) so a crash
 * mid-write never leaves half a file. Unknown keys already in the file are
 * kept — a newer version of Ateam, or a hand edit, may have put them there.
 */
export function updateSettings(patch: SettingsPatch, path: string = settingsPath()): AteamSettings {
	const current = readSettings(path).settings;
	const next: AteamSettings = {
		...current,
		version: SETTINGS_VERSION,
		client: { ...current.client, ...patch.client },
		engine: { ...current.engine, ...patch.engine },
	};
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
	renameSync(tmp, path);
	return next;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Defaults underneath, the file's values on top — per section, so a file
 *  that only has `engine` still gets a complete `client`. */
function merge(raw: Record<string, unknown>): AteamSettings {
	const client = isRecord(raw.client) ? raw.client : {};
	const engine = isRecord(raw.engine) ? raw.engine : {};
	return {
		...DEFAULT_SETTINGS,
		...raw,
		version: SETTINGS_VERSION,
		client: { ...DEFAULT_SETTINGS.client, ...client } as ClientSettings,
		engine: { ...DEFAULT_SETTINGS.engine, ...engine } as EngineSettings,
	};
}
