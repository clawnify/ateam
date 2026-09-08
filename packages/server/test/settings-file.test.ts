import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_SETTINGS,
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

describe("settingsPath", () => {
	it("honours ATEAM_CONFIG, else ~/.ateam/settings.json", () => {
		expect(settingsPath({ ATEAM_CONFIG: "/x/y.json" })).toBe("/x/y.json");
		expect(settingsPath({})).toMatch(/\/\.ateam\/settings\.json$/);
	});
});
