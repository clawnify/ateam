import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createDb, repo } from "@ateam/db";
import { app, BrowserWindow, dialog, Menu } from "electron";
import { autoUpdater } from "electron-updater";
import { type AgentStatus, CH, type KanbanColumn, type MergeStrategy } from "../shared/types";
import { ensureGhShim, ensureNotifyScript } from "./agent-setup";
import { APP_NAME } from "./app-name";
import { type HookEvent, HookServer, type MergeRequestEvent } from "./hooks/hook-server";
import { registerIpc } from "./ipc";
import { createBoardReconciler } from "./loops/board-reconciler";
import { applySetStatus, buildBoardView } from "./loops/board-signals";
import { LoopRunner } from "./loops/runner";
import { MergeQueue } from "./merge-queue";
import { PtyClient } from "./pty/pty-client";
import { type Services, toTaskDTO } from "./services";

// Every live window and the project it's pinned to: null = the main
// multi-project dashboard, a projectId = a detached single-project window.
// Multiplexing projects across windows lets you spread them over macOS Spaces.
const windowProject = new Map<BrowserWindow, string | null>();
let services: Services | null = null;

/**
 * Push an event to every live window. The renderers already filter by their own
 * state (tasksByProject, mounted terminalIds), so a detached project window and
 * the dashboard both stay consistent while each keeps only what it cares about.
 */
function broadcast(channel: string, ...args: unknown[]): void {
	for (const w of windowProject.keys()) {
		if (!w.isDestroyed()) w.webContents.send(channel, ...args);
	}
}

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

function sendTaskUpdated(taskId: string): void {
	if (!services) return;
	const task = repo.getTask(services.db, taskId);
	if (task) broadcast(CH.evtTaskUpdated, toTaskDTO(task));
}

// A task was deleted (single remove or cleanup) — tell every window to drop it,
// so a stale card can't linger in another window showing the same project.
function sendTaskRemoved(taskId: string): void {
	broadcast(CH.evtTaskRemoved, taskId);
}

function sendLoopsUpdated(): void {
	if (!services) return;
	broadcast(CH.evtLoopsUpdated, services.loopRunner.describe());
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
	await ensureGhShim(userDataDir);
	const hooksDir = join(userDataDir, "hooks");
	repo.updateSettings(db, { hookPort });

	const mergeQueue = new MergeQueue({ db, onTaskUpdated: sendTaskUpdated });
	const loopRunner = new LoopRunner({
		db,
		onTaskUpdated: sendTaskUpdated,
		log: (line) => console.log(line),
		mergeQueue,
	});
	loopRunner.register(createBoardReconciler());

	// Board Organizer tools: the organizer loop's headless `claude -p` turn reads
	// the board and proposes moves through these, guarded by validateSetStatus.
	hooks.setBoardHandlers({
		get: () => buildBoardView(db),
		setStatus: async (req) => applySetStatus(db, req, sendTaskUpdated),
	});

	const svc: Services = {
		db,
		pty,
		hooks,
		userDataDir,
		hooksDir,
		notifyScriptPath,
		hookPort,
		mergeQueue,
		loopRunner,
	};

	// PTY output/exit → renderer. shortcut: broadcast to every window; a detached
	// window ignores terminals it hasn't mounted. If PTY throughput ever makes
	// this wasteful, route by terminalId → session → project instead.
	pty.on("data", (e) => broadcast(CH.evtPtyData, e));
	pty.on("exit", (e) => {
		broadcast(CH.evtPtyExit, e);
		// Record the exit in the DB so a session is never left looking "running"
		// after its process is gone — the gap that previously stranded cards in
		// the running column (the board reconciler is the backstop for exits we
		// miss entirely, e.g. while the app was closed).
		const session = repo.getSessionByTerminal(db, e.terminalId);
		if (!session) return;
		if (session.exitedAt == null) {
			repo.updateSession(db, session.id, {
				status: "stopped",
				exitedAt: Date.now(),
			});
		}
		const task = repo.getTask(db, session.taskId);
		if (task && task.column === "running") {
			repo.updateTask(db, task.id, {
				agentStatus: "stopped",
				column:
					task.prNumber != null || (task.gitStatus?.ahead ?? 0) > 0 ? "review" : "needs_attention",
				isUnread: true,
			});
			sendTaskUpdated(task.id);
		}
	});

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
			if (e.eventType === "Working" && task.column === column && task.agentStatus === status) {
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

	// Agent ran `gh pr merge` in its terminal → the gh shim routed it here.
	// Resolve the task from the terminal and enqueue, so terminal merges and the
	// in-app Merge button share one serialized queue per base branch.
	hooks.on("merge-request", (e: MergeRequestEvent) => {
		const session = repo.getSessionByTerminal(db, e.terminalId);
		if (!session) return;
		const task = repo.getTask(db, session.taskId);
		if (!task) return;
		const project = repo.getProject(db, task.projectId);
		if (!project) return;
		const settings = repo.getSettings(db);
		const requested = e.strategy ?? "";
		const strategy = (
			["merge", "squash", "rebase"].includes(requested)
				? requested
				: (settings.defaultMergeStrategy ?? "squash")
		) as MergeStrategy;
		void mergeQueue.enqueue({
			task,
			repoPath: project.repoPath,
			strategy,
			updateStrategy: settings.defaultUpdateStrategy ?? "merge",
			deleteRemoteBranch: settings.deleteRemoteBranchOnMerge ?? false,
		});
	});

	return svc;
}

// A detached window is pinned to `projectId`; the dashboard passes undefined.
function createWindow(projectId?: string): BrowserWindow {
	const win = new BrowserWindow({
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
	windowProject.set(win, projectId ?? null);

	// Pin the project by stamping the renderer URL; the preload reads it back via
	// window.boundProjectId(). A hash keeps loadFile working (no querystring file).
	const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
	if (process.env.ELECTRON_RENDERER_URL) {
		void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${query}`);
	} else {
		void win.loadFile(join(__dirname, "../renderer/index.html"), {
			search: query || undefined,
		});
	}

	win.on("closed", () => {
		windowProject.delete(win);
	});
	return win;
}

// Detach a project into its own window, or focus the one already showing it.
function openProjectWindow(projectId: string): void {
	for (const [w, pid] of windowProject) {
		if (pid === projectId && !w.isDestroyed()) {
			if (w.isMinimized()) w.restore();
			w.focus();
			return;
		}
	}
	createWindow(projectId);
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
	registerIpc({
		services,
		sendTaskUpdated,
		sendTaskRemoved,
		mergeQueue: services.mergeQueue,
		loopRunner: services.loopRunner,
		sendLoopsUpdated,
		openProjectWindow,
	});

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
	buildAppMenu();
	// Start the board reconciler (and any other registered loops) once the
	// window exists, so the first pass can push corrections to the renderer.
	services.loopRunner.start();
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
	// Do NOT kill PTYs — the daemon keeps them alive across restarts. Just
	// disconnect; the daemon stays running with the sessions.
	services?.pty.disconnect();
	services?.hooks.stop();
	services?.loopRunner.stop();
	if (process.platform !== "darwin") app.quit();
});
