// The engine's half of the Browser panel: where this box's noVNC answers, and the
// password to its desktop. The browser itself is installed by
// scripts/install-browser.sh and runs as services that outlive the engine (noVNC
// on loopback, plus the tailnet when the box has one), so there is nothing here
// to start, only to find.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type AteamDb, repo } from "@ateam/db";
import { type BrowserViewDTO, DEFAULT_BROWSER_VIEW_PORT } from "@ateam/protocol";

export const INSTALL_BROWSER_CMD =
	"curl -fsSL https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install-browser.sh | bash";

/** The VNC password install-browser.sh generated, or null when it never ran here. */
export function readVncPassword(dataDir: string): string | null {
	try {
		return readFileSync(join(dataDir, "browser", "vnc-password"), "utf8").trim() || null;
	} catch {
		return null;
	}
}

export async function openBrowserView(dataDir: string): Promise<BrowserViewDTO> {
	const password = readVncPassword(dataDir);
	// Not consent-gated like the editor's install: this one needs sudo once, which
	// only the user can grant on the box itself.
	if (!password)
		throw new Error(
			`This box has no browser yet. Install it on the box with:\n${INSTALL_BROWSER_CMD}`,
		);
	const port = DEFAULT_BROWSER_VIEW_PORT;
	try {
		await fetch(`http://127.0.0.1:${port}/vnc.html`, { signal: AbortSignal.timeout(2000) });
	} catch {
		throw new Error(
			`The box's browser view isn't answering on port ${port}. Check its services (ateam-novnc, ateam-x11vnc, ateam-xvfb).`,
		);
	}
	return { port, password };
}

/**
 * The task's agent called a browser tool (the BrowserUse hook): stamp the task,
 * which is what puts the browser beside its terminal in a client. Only the first
 * call writes, since browser tools are chatty. Returns whether it changed.
 */
export function stampBrowserUse(db: AteamDb, taskId: string, now = Date.now()): boolean {
	const task = repo.getTask(db, taskId);
	if (!task || task.browserUsedAt != null) return false;
	repo.updateTask(db, taskId, { browserUsedAt: now });
	return true;
}
