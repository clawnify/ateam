import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_NOT_INSTALLED_ERROR } from "@ateam/protocol";
import { installBrowser, openBrowserView, readVncPassword } from "../src/browser";

// The Browser button installs through these once the user said yes. The real
// script needs apt and sudo, so each test stands a one-line script in for it.

const dataDir = () => mkdtempSync(join(tmpdir(), "ateam-browser-"));

describe("browser: install", () => {
	test("resolves once the script wrote the VNC password where the engine reads it", async () => {
		const dir = dataDir();
		// The script finds the dir through ATEAM_DATA_DIR, as install-browser.sh does.
		const cmd = `mkdir -p "$ATEAM_DATA_DIR/browser" && echo s3cret > "$ATEAM_DATA_DIR/browser/vnc-password"`;
		await installBrowser(dir, cmd);
		expect(readVncPassword(dir)).toBe("s3cret");
	});

	test("rejects with the script's own reason when it stops", async () => {
		const cmd = `echo '==> [1/6] checks'; printf '\\n!! this needs passwordless sudo once, for apt\\n' >&2; exit 1`;
		await expect(installBrowser(dataDir(), cmd)).rejects.toThrow(
			"The browser install failed: this needs passwordless sudo once, for apt",
		);
	});

	test("a failed download fails the install instead of running an empty script", async () => {
		const cmd = `{ echo 'curl: (6) Could not resolve host' >&2; exit 6; } | bash`;
		await expect(installBrowser(dataDir(), cmd)).rejects.toThrow("Could not resolve host");
	});

	test("rejects when the script exits 0 but left no password", async () => {
		await expect(installBrowser(dataDir(), "true")).rejects.toThrow("finished without writing");
	});

	test("a second call while one runs joins it; a call after it finishes runs again", async () => {
		const dir = dataDir();
		const cmd = `echo run >> "$ATEAM_DATA_DIR/runs"; sleep 0.3; mkdir -p "$ATEAM_DATA_DIR/browser" && echo pw > "$ATEAM_DATA_DIR/browser/vnc-password"`;
		const first = installBrowser(dir, cmd);
		const second = installBrowser(dir, cmd);
		expect(second).toBe(first);
		await Promise.all([first, second]);
		expect(readFileSync(join(dir, "runs"), "utf8")).toBe("run\n");
		await installBrowser(dir, cmd);
		expect(readFileSync(join(dir, "runs"), "utf8")).toBe("run\nrun\n");
	});

	test("keeps the script's output in browser-install.log and names it on failure", async () => {
		const dir = dataDir();
		const cmd = `echo '==> [1/6] install Chrome'; echo 'E: Could not get lock' >&2; exit 100`;
		await expect(installBrowser(dir, cmd)).rejects.toThrow(
			`(log: ${join(dir, "browser-install.log")})`,
		);
		const log = readFileSync(join(dir, "browser-install.log"), "utf8");
		expect(log).toContain("==> [1/6] install Chrome");
		expect(log).toContain("E: Could not get lock");
	});
});

describe("browser: view", () => {
	test("a box with no browser says so in the text the desktop matches", async () => {
		await expect(openBrowserView(dataDir())).rejects.toThrow(BROWSER_NOT_INSTALLED_ERROR);
	});
});
