import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createDb, repo } from "@ateam/db";
import { app, BrowserWindow, dialog } from "electron";
import { autoUpdater } from "electron-updater";
import { type AgentStatus, type KanbanColumn, CH } from "../shared/types";
import { ensureNotifyScript } from "./agent-setup";
import { HookServer, type HookEvent } from "./hooks/hook-server";
import { registerIpc } from "./ipc";
import { PtyClient } from "./pty/pty-client";
import { APP_NAME } from "./app-name";
import { type Services, toTaskDTO } from "./services";

let win: BrowserWindow | null = null;
let services: Services | null = null;

const SMOKE = process.env.ATEAM_SMOKE === "1";

function mapEventToStatus(eventType: string): AgentStatus {
	if (eventType === "PermissionRequest") return "awaiting_input";
	if (eventType === "Stop") return "idle";
	return "running";
}

function mapEventToColumn(eventType: string): KanbanColumn {
	if (eventType === "PermissionRequest") return "needs_attention";
	if (eventType === "Stop") return "review";
	return "running";
}

/**
 * GUI apps on macOS launch with a minimal PATH (/usr/bin:/bin:…), so agent
 * binaries in ~/.local/bin or /opt/homebrew/bin look "not installed" and
 * can't be spawned. Resolve the user's real login-shell PATH once at startup
 * and adopt it — the availability probe, PTY env, and the daemon all inherit
 * process.env.
 *
 * Same for the locale: GUI apps also launch with no LANG/LC_*, and `pbcopy`
 * then interprets UTF-8 input as Mac OS Roman — copying from a terminal turns
 * "→ — €" into ",Üí ,Äî ,Ç¨". Adopt the login shell's LANG, falling back to a
 * UTF-8 locale.
 */
function adoptLoginShellPath(): void {
	if (process.platform !== "darwin") return;
	try {
		const shell = process.env.SHELL || "/bin/zsh";
		const out = execFileSync(
			shell,
			["-ilc", 'printf "__ATEAM_PATH__%s__SEP__%s__END__" "$PATH" "${LANG:-}"'],
			{ encoding: "utf8", timeout: 8000 },
		);
		const m = out.match(/__ATEAM_PATH__([\s\S]*?)__SEP__([\s\S]*?)__END__/);
		if (m?.[1]) process.env.PATH = m[1];
		if (!process.env.LANG) process.env.LANG = m?.[2] || "en_US.UTF-8";
	} catch (err) {
		console.warn("[ateam] could not resolve login-shell PATH:", err);
		process.env.LANG ??= "en_US.UTF-8";
	}
}

/**
 * Auto-update from GitHub Releases (electron-updater), Sparkle-style: ask
 * before downloading (with release notes; "Skip This Version" is remembered),
 * then offer "Restart Now" once downloaded — otherwise it installs on quit.
 * Checks at launch and every 4 hours.
 */
function setupAutoUpdate(): void {
	if (!app.isPackaged) return;
	autoUpdater.autoDownload = false;

	const skipFile = join(app.getPath("userData"), "skipped-version.txt");
	const skippedVersion = (): string => {
		try {
			return readFileSync(skipFile, "utf8").trim();
		} catch {
			return "";
		}
	};
	// "Remind Me Later" = stay quiet until the next app launch.
	let snoozed = false;

	autoUpdater.on("update-available", (info) => {
		if (snoozed || info.version === skippedVersion()) return;
		const notes =
			typeof info.releaseNotes === "string"
				? info.releaseNotes.replace(/<[^>]+>/g, "").trim()
				: "";
		void dialog
			.showMessageBox({
				type: "info",
				title: "Software Update",
				message: `A new version of Ateam is available!`,
				detail: `Ateam ${info.version} is now available — you have ${app.getVersion()}. Would you like to download it now?${notes ? `\n\n${notes.slice(0, 1500)}` : ""}`,
				buttons: ["Install Update", "Remind Me Later", "Skip This Version"],
				defaultId: 0,
				cancelId: 1,
			})
			.then(({ response }) => {
				if (response === 0) {
					void autoUpdater
						.downloadUpdate()
						.catch((err) =>
							console.warn("[ateam] update download failed:", err),
						);
				} else if (response === 1) {
					snoozed = true;
				} else {
					try {
						writeFileSync(skipFile, info.version, "utf8");
					} catch {
						/* best-effort */
					}
				}
			});
	});

	autoUpdater.on("update-downloaded", (info) => {
		void dialog
			.showMessageBox({
				type: "info",
				title: "Update Ready",
				message: `Ateam ${info.version} has been downloaded.`,
				detail:
					"Restart now to apply it — or keep working, and it will install when you quit. Agent terminals survive the restart.",
				buttons: ["Restart Now", "Later"],
				defaultId: 0,
				cancelId: 1,
			})
			.then(({ response }) => {
				if (response === 0) autoUpdater.quitAndInstall();
			});
	});

	const check = () =>
		autoUpdater
			.checkForUpdates()
			.catch((err) => console.warn("[ateam] update check failed:", err));
	check();
	setInterval(check, 4 * 60 * 60 * 1000);
}

function sendTaskUpdated(taskId: string): void {
	if (!services) return;
	const task = repo.getTask(services.db, taskId);
	if (task) win?.webContents.send(CH.evtTaskUpdated, toTaskDTO(task));
}

async function initServices(): Promise<Services> {
	const userDataDir = app.getPath("userData");
	// One-time migration from the pre-rename database filename.
	const dbPath = join(userDataDir, "ateam.sqlite");
	if (!existsSync(dbPath) && existsSync(join(userDataDir, "grove.sqlite"))) {
		for (const suffix of ["", "-wal", "-shm"]) {
			const old = join(userDataDir, `grove.sqlite${suffix}`);
			if (existsSync(old)) renameSync(old, `${dbPath}${suffix}`);
		}
	}
	const db = createDb(dbPath);
	// The detached PTY daemon survives app restarts; out/main/daemon.js is run via
	// the Electron binary as node (ELECTRON_RUN_AS_NODE) so node-pty's ABI matches.
	const pty = new PtyClient(
		join(__dirname, "daemon.js"),
		join(homedir(), ".ateam", "pty-daemon.sock"),
		process.execPath,
	);
	const hooks = new HookServer();
	const hookPort = await hooks.start(repo.getSettings(db).hookPort ?? undefined);
	const notifyScriptPath = await ensureNotifyScript(userDataDir);
	const hooksDir = join(userDataDir, "hooks");
	repo.updateSettings(db, { hookPort });

	const svc: Services = {
		db,
		pty,
		hooks,
		userDataDir,
		hooksDir,
		notifyScriptPath,
		hookPort,
	};

	// PTY output/exit → renderer.
	pty.on("data", (e) => win?.webContents.send(CH.evtPtyData, e));
	pty.on("exit", (e) => win?.webContents.send(CH.evtPtyExit, e));

	// Agent status hooks → update session/task, drive the kanban column.
	hooks.on("hook", (e: HookEvent) => {
		const session = repo.getSessionByTerminal(db, e.terminalId);
		if (!session) return;
		const status = mapEventToStatus(e.eventType);
		repo.updateSession(db, session.id, {
			status,
			lastEventAt: Date.now(),
		});
		// "Working" fires on every tool use — too chatty for the append-only
		// event log; it only needs to drive status/column.
		if (e.eventType !== "Working") {
			repo.recordEvent(db, {
				sessionId: session.id,
				terminalId: e.terminalId,
				eventType: e.eventType,
				rawAgentSessionId: e.sessionId ?? null,
			});
		}
		const task = repo.getTask(db, session.taskId);
		if (task) {
			const column = mapEventToColumn(e.eventType);
			// Subagents fire PreToolUse too, so a Working event must never mask a
			// pending question — only an explicit user reply (UserReply), Stop, or
			// a fresh Start may move a task out of needs_attention.
			if (e.eventType === "Working" && task.column === "needs_attention") {
				return;
			}
			// Skip no-op Working updates so the renderer isn't pinged per tool use.
			if (
				e.eventType === "Working" &&
				task.column === column &&
				task.agentStatus === status
			) {
				return;
			}
			repo.updateTask(db, task.id, {
				agentStatus: status,
				column,
				lastEventAt: Date.now(),
				// Working/Start mean the user just interacted or launched — the
				// task isn't "unread"; Stop/PermissionRequest are news for them.
				isUnread: e.eventType === "Stop" || e.eventType === "PermissionRequest",
			});
			sendTaskUpdated(task.id);
		}
	});

	return svc;
}

function createWindow(): void {
	win = new BrowserWindow({
		width: 1400,
		height: 900,
		minWidth: 900,
		minHeight: 600,
		title: APP_NAME,
		backgroundColor: "#0c0c0e",
		titleBarStyle: "hiddenInset",
		webPreferences: {
			preload: join(__dirname, "../preload/index.js"),
			sandbox: false,
			contextIsolation: true,
		},
	});

	if (process.env.ELECTRON_RENDERER_URL) {
		void win.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		void win.loadFile(join(__dirname, "../renderer/index.html"));
	}

	win.on("closed", () => {
		win = null;
	});
}

app.whenReady().then(async () => {
	app.setName(APP_NAME);
	adoptLoginShellPath();

	// Show the app icon in the macOS dock during dev (packaged builds use the
	// .icns in build/). Best-effort: the icon lives at build/icon.png.
	if (process.platform === "darwin" && app.dock) {
		for (const p of [
			join(process.cwd(), "build", "icon.png"),
			join(__dirname, "../../build/icon.png"),
		]) {
			try {
				app.dock.setIcon(p);
				break;
			} catch {
				/* try next path */
			}
		}
	}

	services = await initServices();
	registerIpc({ services, sendTaskUpdated });

	if (SMOKE) {
		// Headless boot check: prove services init (db, hook server, notify
		// script) without opening a window or the daemon, then exit cleanly.
		console.log(`ATEAM_READY hookPort=${services.hookPort}`);
		services.hooks.stop();
		app.exit(0);
		return;
	}

	// Connect to (or launch) the PTY daemon and learn which sessions are still
	// alive from a previous run, so the renderer can re-attach to them.
	try {
		await services.pty.connect();
	} catch (err) {
		console.error("[ateam] PTY daemon connect failed:", err);
	}

	createWindow();
	setupAutoUpdate();
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	// Do NOT kill PTYs — the daemon keeps them alive across restarts. Just
	// disconnect; the daemon stays running with the sessions.
	services?.pty.disconnect();
	services?.hooks.stop();
	if (process.platform !== "darwin") app.quit();
});
