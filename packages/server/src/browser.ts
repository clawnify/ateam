// The engine's half of the Browser panel: where this box's noVNC answers, and the
// password to its desktop. The browser itself is installed by
// scripts/install-browser.sh and runs as services that outlive the engine (noVNC
// on loopback, plus the tailnet when the box has one), so there is nothing here
// to start, only to find, or to install once the user said yes.
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { type AteamDb, repo } from "@ateam/db";
import {
	BROWSER_NOT_INSTALLED_ERROR,
	type BrowserViewDTO,
	DEFAULT_BROWSER_VIEW_PORT,
} from "@ateam/protocol";

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

/** The install running now. A second caller (a second click, window or Mac)
 *  waits on it rather than starting a second script beside it: two runs collide
 *  on apt's lock and write into the same TaskWindow prefix at once. */
let installing: Promise<void> | null = null;

/**
 * Run install-browser.sh on THIS machine. Consent lives with the caller: engines
 * only run this after a client relayed the user's yes. The script never prompts
 * (without passwordless sudo it stops and says so), so it runs fine with no
 * terminal. Its output goes to browser-install.log in `dataDir`. `cmd` is
 * injectable for tests.
 */
export function installBrowser(dataDir: string, cmd = INSTALL_BROWSER_CMD): Promise<void> {
	installing ??= runInstall(dataDir, cmd).finally(() => {
		installing = null;
	});
	return installing;
}

function runInstall(dataDir: string, cmd: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const logPath = join(dataDir, "browser-install.log");
		const log = openSync(logPath, "a");
		// pipefail: a download that failed must not pipe an empty script into a
		// bash that then exits 0. ATEAM_DATA_DIR: the script writes the VNC
		// password where this engine reads it, even when the engine's dir moved.
		const child = spawn("bash", ["-o", "pipefail", "-c", cmd], {
			env: { ...process.env, ATEAM_DATA_DIR: dataDir },
			stdio: ["ignore", log, "pipe"],
			timeout: 20 * 60_000,
		});
		// The script reports progress on stdout and only failures on stderr, so
		// stderr is also kept here, for the reason to show.
		let stderr = "";
		child.stderr?.on("data", (d) => {
			writeSync(log, d);
			stderr = (stderr + d).slice(-4000);
		});
		// A failed spawn can emit both "error" and "close": close the log once.
		let open = true;
		const closeLog = () => {
			if (open) closeSync(log);
			open = false;
		};
		child.on("error", (err) => {
			closeLog();
			reject(err);
		});
		child.on("close", (code, signal) => {
			closeLog();
			if (code === 0 && readVncPassword(dataDir)) return resolve();
			const tail = stderr
				.split("\n")
				.map((l) => l.replace(/^!! /, "").trim())
				.filter(Boolean)
				.slice(-3)
				.join(" ");
			const why = signal
				? "it ran for 20 minutes without finishing"
				: code === 0
					? `it finished without writing ${join(dataDir, "browser", "vnc-password")}`
					: tail || `exit ${code}`;
			reject(new Error(`The browser install failed: ${why} (log: ${logPath})`));
		});
	});
}

export async function openBrowserView(dataDir: string): Promise<BrowserViewDTO> {
	const password = readVncPassword(dataDir);
	// The command stays in the message for a client that can't install (the
	// phone, an older desktop): it is still the way in from a box terminal.
	if (!password)
		throw new Error(
			`${BROWSER_NOT_INSTALLED_ERROR}. Install it on the box with:\n${INSTALL_BROWSER_CMD}`,
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
