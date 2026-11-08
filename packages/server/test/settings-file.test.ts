import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_SETTINGS,
	hasBoxChoice,
	idleSleepMinutesOf,
	readSettings,
	SETTINGS_VERSION,
	settingsPath,
	updateSettings,
} from "../src/settings-file";

// The file is hand-editable by design, so every shape a human (or an older
// Ateam) can leave it in has to read back as something usable, and nothing a
// human wrote may vanish without a trace.

const scratch = () => join(mkdtempSync(join(tmpdir(), "ateam-settings-")), "settings.json");

describe("readSettings", () => {
	it("an absent file is first run: defaults, no warning", () => {
		const r = readSettings(scratch());
		expect(r.settings).toEqual(DEFAULT_SETTINGS);
		expect(r.warning).toBeUndefined();
	});

	it("fills what a partial file leaves out, per section", () => {
		const p = scratch();
		writeFileSync(p, JSON.stringify({ engine: { defaultAgentId: "opencode" } }));
		const { settings, warning } = readSettings(p);
		expect(warning).toBeUndefined();
		expect(settings.engine.defaultAgentId).toBe("opencode");
		expect(settings.engine.defaultMergeStrategy).toBe("squash");
		expect(settings.client).toEqual(DEFAULT_SETTINGS.client);
		expect(settings.version).toBe(SETTINGS_VERSION);
	});

	it("invalid JSON falls back to defaults, warns, and keeps the file as .bad", () => {
		const p = scratch();
		writeFileSync(p, "{ not json");
		const { settings, warning } = readSettings(p);
		expect(settings).toEqual(DEFAULT_SETTINGS);
		expect(warning).toContain("not valid JSON");
		expect(existsSync(p)).toBe(false);
		expect(readFileSync(`${p}.bad`, "utf8")).toBe("{ not json");
	});

	it("a JSON value that is not an object is refused, not merged", () => {
		const p = scratch();
		writeFileSync(p, "[1,2,3]");
		const { settings, warning } = readSettings(p);
		expect(settings).toEqual(DEFAULT_SETTINGS);
		expect(warning).toContain("JSON object");
	});
});

describe("updateSettings", () => {
	it("creates the file and its directory on first write", () => {
		const p = join(mkdtempSync(join(tmpdir(), "ateam-settings-")), "nested", "settings.json");
		updateSettings({ engine: { defaultAgentId: "codex" } }, p);
		expect(JSON.parse(readFileSync(p, "utf8")).engine.defaultAgentId).toBe("codex");
	});

	it("patches one key and leaves the rest, including keys it does not know", () => {
		const p = scratch();
		writeFileSync(
			p,
			JSON.stringify({
				version: 1,
				engine: { defaultAgentId: "opencode" },
				future: { keptForANewerAteam: true },
			}),
		);
		updateSettings({ client: { autoDownloadUpdates: true } }, p);
		const raw = JSON.parse(readFileSync(p, "utf8"));
		expect(raw.engine.defaultAgentId).toBe("opencode");
		expect(raw.client.autoDownloadUpdates).toBe(true);
		expect(raw.future).toEqual({ keptForANewerAteam: true });
	});

	it("leaves no .tmp behind", () => {
		const p = scratch();
		updateSettings({}, p);
		expect(existsSync(`${p}.tmp`)).toBe(false);
	});
});

describe("a box's own settings", () => {
	it("a box is not always on until someone says so, and a file without the section reads that way", () => {
		const p = scratch();
		writeFileSync(p, JSON.stringify({ engine: { idleSleepMinutes: 30 } }));
		expect(readSettings(p).settings.box).toEqual({ alwaysOn: false });
		expect(idleSleepMinutesOf(readSettings(p).settings)).toBe(30);
	});

	it("always on wins over the idle window a Mac pushes, and a push of engine leaves it alone", () => {
		const p = scratch();
		updateSettings({ box: { alwaysOn: true } }, p);
		// What a Mac's settings sync sends: engine only.
		updateSettings({ engine: { idleSleepMinutes: 60 } }, p);
		const { settings } = readSettings(p);
		expect(settings.box.alwaysOn).toBe(true);
		expect(idleSleepMinutesOf(settings)).toBe(0);
		updateSettings({ box: { alwaysOn: false } }, p);
		expect(idleSleepMinutesOf(readSettings(p).settings)).toBe(60);
	});

	it("tells a choice written in the file from the default filling it in", () => {
		const p = scratch();
		expect(hasBoxChoice(p)).toBe(false);
		updateSettings({ engine: { idleSleepMinutes: 30 } }, p);
		// updateSettings writes the whole object, defaults included, so this reads as a
		// choice once anything was saved. The engine asks before its first save.
		expect(hasBoxChoice(p)).toBe(true);
		writeFileSync(p, JSON.stringify({ engine: { idleSleepMinutes: 30 } }));
		expect(hasBoxChoice(p)).toBe(false);
		writeFileSync(p, JSON.stringify({ box: { alwaysOn: false } }));
		expect(hasBoxChoice(p)).toBe(true);
	});
});

describe("settingsPath", () => {
	it("honours ATEAM_CONFIG, else ~/.ateam/settings.json", () => {
		expect(settingsPath({ ATEAM_CONFIG: "/x/y.json" })).toBe("/x/y.json");
		expect(settingsPath({})).toMatch(/\/\.ateam\/settings\.json$/);
	});
});
