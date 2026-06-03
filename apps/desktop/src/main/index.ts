import { homedir } from "node:os";
import { join } from "node:path";
import { createDb, repo } from "@grove/db";
import { app, BrowserWindow } from "electron";
import { type AgentStatus, type KanbanColumn, CH } from "../shared/types";
import { ensureNotifyScript } from "./agent-setup";
import { HookServer, type HookEvent } from "./hooks/hook-server";
import { registerIpc } from "./ipc";
import { PtyClient } from "./pty/pty-client";
import { APP_NAME } from "./app-name";
import { type Services, toTaskDTO } from "./services";

let win: BrowserWindow | null = null;
let services: Services | null = null;

const SMOKE = process.env.GROVE_SMOKE === "1";

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

function sendTaskUpdated(taskId: string): void {
	if (!services) return;
	const task = repo.getTask(services.db, taskId);
	if (task) win?.webContents.send(CH.evtTaskUpdated, toTaskDTO(task));
}

async function initServices(): Promise<Services> {
	const userDataDir = app.getPath("userData");
	const db = createDb(join(userDataDir, "grove.sqlite"));
	// The detached PTY daemon survives app restarts; out/main/daemon.js is run via
	// the Electron binary as node (ELECTRON_RUN_AS_NODE) so node-pty's ABI matches.
	const pty = new PtyClient(
		join(__dirname, "daemon.js"),
		join(homedir(), ".ateam", "pty-daemon.sock"),
		process.execPath,
	);
	const hooks = new HookServer();
	const hookPort = await hooks.start();
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
		repo.recordEvent(db, {
			sessionId: session.id,
			terminalId: e.terminalId,
			eventType: e.eventType,
			rawAgentSessionId: e.sessionId ?? null,
		});
		const task = repo.getTask(db, session.taskId);
		if (task) {
			repo.updateTask(db, task.id, {
				agentStatus: status,
				column: mapEventToColumn(e.eventType),
				lastEventAt: Date.now(),
				isUnread: e.eventType !== "Start",
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
		console.log(`GROVE_READY hookPort=${services.hookPort}`);
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
