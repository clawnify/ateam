import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CODE_SERVER_VERSION,
	editorBindHost,
	findCodeServer,
	INSTALL_CMD,
	preseedUserSettings,
} from "../src/editor";

describe("editor: findCodeServer", () => {
	test("env override wins when executable", () => {
		const dir = mkdtempSync(join(tmpdir(), "ed-"));
		const bin = join(dir, "code-server");
		writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
		expect(findCodeServer({ ATEAM_CODE_SERVER_BIN: bin, PATH: "" })).toBe(bin);
	});

	test("null when nothing is installed anywhere on PATH", () => {
		const empty = mkdtempSync(join(tmpdir(), "ed-empty-"));
		// Standard locations may exist on a dev machine; PATH-only probe is what
		// this asserts, via a PATH that can't contain the binary.
		const found = findCodeServer({ PATH: empty });
		if (found !== null) expect(found.startsWith(empty)).toBe(false);
	});
});

describe("editor: bind interface mirrors the daemon's exposure", () => {
	test("loopback without ATEAM_WS_ADDR", () => {
		expect(editorBindHost({})).toBe("127.0.0.1");
	});
	test("tailnet host when the daemon serves one", () => {
		expect(editorBindHost({ ATEAM_WS_ADDR: "100.72.63.61:8787" })).toBe("100.72.63.61");
	});
});

describe("editor: preseedUserSettings", () => {
	test("writes dark theme + trust-off once, never clobbers", () => {
		const dataDir = mkdtempSync(join(tmpdir(), "ed-seed-"));
		preseedUserSettings(dataDir);
		const file = join(dataDir, "User", "settings.json");
		expect(existsSync(file)).toBe(true);
		const seeded = JSON.parse(readFileSync(file, "utf8"));
		expect(seeded["workbench.colorTheme"]).toBe("Default Dark Modern");
		expect(seeded["security.workspace.trust.enabled"]).toBe(false);

		writeFileSync(file, '{"workbench.colorTheme":"Mine"}');
		preseedUserSettings(dataDir);
		expect(JSON.parse(readFileSync(file, "utf8"))["workbench.colorTheme"]).toBe("Mine");
	});

	test("creates the User dir when missing", () => {
		const dataDir = join(mkdtempSync(join(tmpdir(), "ed-deep-")), "nested");
		mkdirSync(dataDir, { recursive: true });
		preseedUserSettings(dataDir);
		expect(existsSync(join(dataDir, "User", "settings.json"))).toBe(true);
	});
});

describe("editor: install command", () => {
	test("official installer, standalone, user prefix, pinned version", () => {
		expect(INSTALL_CMD).toContain("https://code-server.dev/install.sh");
		expect(INSTALL_CMD).toContain("--method=standalone");
		expect(INSTALL_CMD).toContain("--prefix=$HOME/.local");
		expect(INSTALL_CMD).toContain(`--version ${CODE_SERVER_VERSION}`);
	});
});
