import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, dialog, Menu } from "electron";
import { autoUpdater } from "electron-updater";
import { createEngine, type Engine } from "@ateam/server";
import { APP_NAME } from "./app-name";
import { createHost, registerHostIpc } from "./host";
import { registerIpc } from "./ipc";

let win: BrowserWindow | null = null;
let engine: Engine | null = null;

const SMOKE = process.env.ATEAM_SMOKE === "1";

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

// Triggers a manual update check (with "you're up to date" feedback). Wired by
// setupAutoUpdate() once auto-update is active; null in dev / unpackaged builds.
let triggerUpdateCheck: (() => void) | null = null;

// "Check for Updates…" menu handler — works even when auto-update is inactive.
function onCheckForUpdates(): void {
	if (triggerUpdateCheck) {
		triggerUpdateCheck();
		return;
	}
	void dialog.showMessageBox({
		type: "info",
		title: "Software Update",
		message: "Updates aren't available in development builds.",
		detail: `You're running Ateam ${app.getVersion()}.`,
		buttons: ["OK"],
	});
}

/**
 * Auto-update from GitHub Releases (electron-updater), Sparkle-style: ask
 * before downloading (with release notes; "Skip This Version" is remembered),
 * then offer "Restart Now" once downloaded — otherwise it installs on quit.
 * Checks at launch and every 4 hours, plus on demand via "Check for Updates…".
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
	// A user-initiated check reports its result (incl. "up to date") and ignores
	// snooze/skip; background checks stay silent unless there's a fresh update.
	let manualCheck = false;

	autoUpdater.on("update-available", (info) => {
		if (!manualCheck && (snoozed || info.version === skippedVersion())) return;
		const notes =
			typeof info.releaseNotes === "string" ? info.releaseNotes.replace(/<[^>]+>/g, "").trim() : "";
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
						.catch((err) => console.warn("[ateam] update download failed:", err));
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

	autoUpdater.on("update-not-available", () => {
		if (!manualCheck) return;
		manualCheck = false;
		void dialog.showMessageBox({
			type: "info",
			title: "Software Update",
			message: "You're up to date!",
			detail: `Ateam ${app.getVersion()} is the latest version.`,
			buttons: ["OK"],
		});
	});

	autoUpdater.on("error", (err) => {
		console.warn("[ateam] update check failed:", err);
		if (!manualCheck) return;
		manualCheck = false;
		void dialog.showMessageBox({
			type: "warning",
			title: "Software Update",
			message: "Couldn't check for updates.",
			detail: String(err?.message ?? err),
			buttons: ["OK"],
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

	const check = (manual: boolean) => {
		manualCheck = manual;
		return autoUpdater
			.checkForUpdates()
			.catch((err) => console.warn("[ateam] update check failed:", err));
	};
	triggerUpdateCheck = () => void check(true);
	void check(false);
	setInterval(() => check(false), 4 * 60 * 60 * 1000);
}

/**
 * Build the application menu. macOS gets the standard app menu (named after the
 * product) with a "Check for Updates…" item; the Edit/View/Window menus keep
 * copy/paste, devtools, and window roles that the default menu would otherwise
 * provide (the agent terminals rely on copy/paste).
 */
function buildAppMenu(): void {
	const isMac = process.platform === "darwin";
	const template: Electron.MenuItemConstructorOptions[] = [
		...(isMac
			? [
					{
						label: APP_NAME,
						submenu: [
							{ role: "about" as const },
							{
								label: "Check for Updates…",
								click: () => onCheckForUpdates(),
							},
							{ type: "separator" as const },
							{ role: "services" as const },
							{ type: "separator" as const },
							{ role: "hide" as const },
							{ role: "hideOthers" as const },
							{ role: "unhide" as const },
							{ type: "separator" as const },
							{ role: "quit" as const },
						],
					} as Electron.MenuItemConstructorOptions,
				]
			: []),
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "forceReload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{
			label: "Window",
			submenu: [
				{ role: "minimize" },
				{ role: "zoom" },
				...(isMac
					? [{ type: "separator" as const }, { role: "front" as const }]
					: [{ role: "close" as const }]),
			],
		},
		...(isMac
			? []
			: [
					{
						label: "Help",
						submenu: [
							{
								label: "Check for Updates…",
								click: () => onCheckForUpdates(),
							},
						],
					} as Electron.MenuItemConstructorOptions,
				]),
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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

	engine = await createEngine({
		dataDir: app.getPath("userData"),
		// The detached PTY daemon (out/main/daemon.js) is run via the Electron
		// binary as node (ELECTRON_RUN_AS_NODE) so node-pty's ABI matches.
		daemonPath: join(__dirname, "daemon.js"),
		execPath: process.execPath,
	});
	// The local engine is the default backend; the host swaps in a remote one (over
	// SSH) on connect and re-points the IPC bridge + event forwarding at it. Binding
	// the engine's events to the renderer is the host's job now (see createHost).
	const host = createHost({ localEngine: engine, getWin: () => win });
	registerIpc(host.router);
	registerHostIpc(host);

	if (SMOKE) {
		// Headless boot check: prove the engine inits (db, hook server, notify
		// script) without opening a window or the daemon, then exit cleanly.
		console.log(`ATEAM_READY hookPort=${engine.services.hookPort}`);
		engine.stopHooks();
		app.exit(0);
		return;
	}

	// Connect to (or launch) the PTY daemon and learn which sessions are still
	// alive from a previous run, so the renderer can re-attach to them.
	try {
		await engine.connectPty();
	} catch (err) {
		console.error("[ateam] PTY daemon connect failed:", err);
	}

	createWindow();
	buildAppMenu();
	// Start the board reconciler (and any other registered loops) once the
	// window exists, so the first pass can push corrections to the renderer.
	engine.startLoops();
	setupAutoUpdate();
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
}).catch((err) => {
	// A startup failure (e.g. a native module built for the wrong CPU arch)
	// would otherwise leave a live process with no window and no feedback —
	// exactly the "click the app, nothing happens" symptom. Surface it and quit.
	console.error("[ateam] startup failed:", err);
	dialog.showErrorBox(
		"Ateam failed to start",
		`${APP_NAME} couldn't start and needs to close.\n\n${
			err instanceof Error ? (err.stack ?? err.message) : String(err)
		}`,
	);
	app.exit(1);
});

app.on("window-all-closed", () => {
	// Do NOT kill PTYs — the daemon keeps them alive across restarts. engine.stop
	// just disconnects the client and stops hooks/loops; the daemon stays running.
	engine?.stop();
	if (process.platform !== "darwin") app.quit();
});
