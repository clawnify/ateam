import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { BROWSER_NOT_INSTALLED_ERROR } from "@ateam/protocol";
import { createDesktopServer } from "../../desktop-control/src/server";
import { viewerScript } from "../../desktop-control/src/viewer";
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

	test("released clients forward bundled credentials into the actual viewer script", async () => {
		const dir = dataDir();
		mkdirSync(join(dir, "browser"));
		writeFileSync(join(dir, "browser/vnc-password"), "old-pass");
		const token = "a".repeat(64);
		writeFileSync(join(dir, "browser/desktop-viewer-token"), token);
		const gateway = createDesktopServer({ token: "agent-secret", viewerToken: token });
		const server = gateway.server();
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const originalFetch = globalThis.fetch;
		const fetchMock = spyOn(globalThis, "fetch").mockImplementation(() =>
			originalFetch(`${url}/vnc.html`),
		);
		try {
			const view = await openBrowserView(dir);
			// This is the released clients' URL contract: unknown DTO fields vanish.
			const hash = `#autoconnect=true&resize=scale&reconnect=true&password=${encodeURIComponent(view.password)}`;
			let protocols: string[] = [];
			let credentials: unknown;
			const element = { addEventListener() {} };
			runInNewContext(viewerScript.replace(/^import .*;$/gm, ""), {
				URLSearchParams,
				location: { hash, protocol: "http:", host: "localhost" },
				document: { getElementById: () => element, addEventListener() {} },
				ResizeObserver: class {
					observe() {}
				},
				crypto: { randomUUID: () => "12345678-1234-1234-1234-123456789abc" },
				WebSocket: class {
					constructor(_url: string, offered: string[]) {
						protocols = offered;
					}
				},
				InputHandoff: class {},
				RFB: class {
					constructor(_screen: unknown, _socket: unknown, opts: unknown) {
						credentials = opts;
					}
					addEventListener() {}
				},
				addEventListener() {},
				setInterval() {},
			});
			expect(protocols).toEqual(["binary", `desktop-view.${token}`]);
			expect(credentials).toEqual({ credentials: { password: "old-pass" }, shared: true });
			// A legacy viewer after rollback must still receive its raw VNC password.
			fetchMock.mockImplementation(() => Promise.resolve(new Response("legacy noVNC")));
			expect((await openBrowserView(dir)).password).toBe("old-pass");
		} finally {
			fetchMock.mockRestore();
			gateway.close();
		}
	});
});
