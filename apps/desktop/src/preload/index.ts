import {
	type AteamApi,
	CH,
	type KanbanColumn,
	type LoopDTO,
	type MergeStrategy,
	type PtyDataEvent,
	type PtyExitEvent,
	type TaskDTO,
} from "@ateam/protocol";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
	type AteamHost,
	type CreateProgressEvent,
	HOST_CH,
	type HostStatus,
	type InstallLogEvent,
} from "../shared/host";

const api: AteamApi = {
	projects: {
		pick: () => ipcRenderer.invoke(CH.projectsPick),
		register: (repoPath, opts) => ipcRenderer.invoke(CH.projectsRegister, repoPath, opts),
		remoteUrl: (projectId) => ipcRenderer.invoke(CH.projectsRemoteUrl, projectId),
		list: () => ipcRenderer.invoke(CH.projectsList),
		remove: (id) => ipcRenderer.invoke(CH.projectsRemove, id),
	},
	tasks: {
		list: (projectId) => ipcRenderer.invoke(CH.tasksList, projectId),
		create: (input) => ipcRenderer.invoke(CH.tasksCreate, input),
		remove: (input) => ipcRenderer.invoke(CH.tasksRemove, input),
		setColumn: (id, column: KanbanColumn) => ipcRenderer.invoke(CH.tasksSetColumn, id, column),
		cleanupPreview: (projectId) => ipcRenderer.invoke(CH.tasksCleanupPreview, projectId),
		cleanup: (projectId) => ipcRenderer.invoke(CH.tasksCleanup, projectId),
		cleanupCandidates: (projectId) => ipcRenderer.invoke(CH.tasksCleanupCandidates, projectId),
	},
	git: {
		commit: (taskId, message) => ipcRenderer.invoke(CH.gitCommit, taskId, message),
		push: (taskId) => ipcRenderer.invoke(CH.gitPush, taskId),
		update: (taskId) => ipcRenderer.invoke(CH.gitUpdate, taskId),
		merge: (taskId, strategy: MergeStrategy) => ipcRenderer.invoke(CH.gitMerge, taskId, strategy),
		diff: (taskId) => ipcRenderer.invoke(CH.gitDiff, taskId),
		fileDiff: (taskId, file) => ipcRenderer.invoke(CH.gitFileDiff, taskId, file),
		status: (taskId) => ipcRenderer.invoke(CH.gitStatus, taskId),
	},
	agents: {
		list: () => ipcRenderer.invoke(CH.agentsList),
	},
	editor: {
		open: (taskId) => ipcRenderer.invoke(CH.editorOpenUrl, taskId),
	},
	search: {
		sessions: (input) => ipcRenderer.invoke(CH.searchSessions, input),
	},
	fs: {
		listDir: (path) => ipcRenderer.invoke(CH.fsListDir, path),
	},
	loops: {
		list: () => ipcRenderer.invoke(CH.loopsList),
		setEnabled: (id, enabled) => ipcRenderer.invoke(CH.loopsSetEnabled, id, enabled),
		runNow: (id) => ipcRenderer.invoke(CH.loopsRunNow, id),
		templates: () => ipcRenderer.invoke(CH.loopsTemplates),
		create: (input) => ipcRenderer.invoke(CH.loopsCreate, input),
		update: (input) => ipcRenderer.invoke(CH.loopsUpdate, input),
		remove: (id) => ipcRenderer.invoke(CH.loopsDelete, id),
		onUpdated: (cb: (loops: LoopDTO[]) => void) => {
			const handler = (_: unknown, loops: LoopDTO[]) => cb(loops);
			ipcRenderer.on(CH.evtLoopsUpdated, handler);
			return () => ipcRenderer.off(CH.evtLoopsUpdated, handler);
		},
	},
	pty: {
		spawnAgent: (input) => ipcRenderer.invoke(CH.ptySpawnAgent, input),
		spawnShell: (input) => ipcRenderer.invoke(CH.ptySpawnShell, input),
		write: (terminalId, data) => ipcRenderer.send(CH.ptyWrite, terminalId, data),
		resize: (terminalId, cols, rows) => ipcRenderer.send(CH.ptyResize, terminalId, cols, rows),
		kill: (terminalId) => ipcRenderer.invoke(CH.ptyKill, terminalId),
		snapshot: (terminalId) => ipcRenderer.invoke(CH.ptySnapshot, terminalId),
		listForTask: (taskId) => ipcRenderer.invoke(CH.ptyListForTask, taskId),
		onData: (cb: (e: PtyDataEvent) => void) => {
			const handler = (_: unknown, e: PtyDataEvent) => cb(e);
			ipcRenderer.on(CH.evtPtyData, handler);
			return () => ipcRenderer.off(CH.evtPtyData, handler);
		},
		onExit: (cb: (e: PtyExitEvent) => void) => {
			const handler = (_: unknown, e: PtyExitEvent) => cb(e);
			ipcRenderer.on(CH.evtPtyExit, handler);
			return () => ipcRenderer.off(CH.evtPtyExit, handler);
		},
	},
	utils: {
		pathForFile: (file) => webUtils.getPathForFile(file),
		pickFiles: () => ipcRenderer.invoke(CH.utilPickFiles),
		attachImages: (terminalId, paths) => ipcRenderer.invoke(CH.utilAttachImages, terminalId, paths),
		attachClipboardImage: (terminalId) =>
			ipcRenderer.invoke(CH.utilAttachClipboardImage, terminalId),
		writeImageBytes: (base64, ext) => ipcRenderer.invoke(CH.utilWriteImageBytes, base64, ext),
		openInEditor: (worktreePath, alias) =>
			ipcRenderer.invoke(CH.utilOpenInEditor, worktreePath, alias),
	},
	events: {
		onTaskUpdated: (cb: (task: TaskDTO) => void) => {
			const handler = (_: unknown, task: TaskDTO) => cb(task);
			ipcRenderer.on(CH.evtTaskUpdated, handler);
			return () => ipcRenderer.off(CH.evtTaskUpdated, handler);
		},
		onTaskRemoved: (cb: (taskId: string) => void) => {
			const handler = (_: unknown, taskId: string) => cb(taskId);
			ipcRenderer.on(CH.evtTaskRemoved, handler);
			return () => ipcRenderer.off(CH.evtTaskRemoved, handler);
		},
	},
	window: {
		openProject: (projectId) => ipcRenderer.invoke(CH.windowOpenProject, projectId),
		// The main process stamps ?projectId=<id> onto a detached window's URL. The
		// preload runs in the renderer world, so `location` exists at runtime; this
		// project is node-typed (no DOM lib), so reach it through globalThis.
		boundProjectId: () =>
			new URLSearchParams(
				(globalThis as { location?: { search: string } }).location?.search ?? "",
			).get("projectId"),
	},
};

contextBridge.exposeInMainWorld("ateam", api);

// The connection-control surface (which engine drives the app) — separate from
// window.ateam (the engine itself). See apps/desktop/src/shared/host.ts.
const host: AteamHost = {
	list: () => ipcRenderer.invoke(HOST_CH.list),
	connect: (alias) => ipcRenderer.invoke(HOST_CH.connect, alias),
	disconnect: (alias) => ipcRenderer.invoke(HOST_CH.disconnect, alias),
	forget: (alias) => ipcRenderer.invoke(HOST_CH.forget, alias),
	connected: () => ipcRenderer.invoke(HOST_CH.connected),
	origins: () => ipcRenderer.invoke(HOST_CH.origins),
	provision: (alias, input) => ipcRenderer.invoke(HOST_CH.provision, alias, input),
	install: (dest, opts) => ipcRenderer.invoke(HOST_CH.install, dest, opts),
	createBox: (spec) => ipcRenderer.invoke(HOST_CH.createBox, spec),
	installAgent: (alias, agentId) => ipcRenderer.invoke(HOST_CH.installAgent, alias, agentId),
	boxReadiness: (alias) => ipcRenderer.invoke(HOST_CH.boxReadiness, alias),
	secretsStatus: () => ipcRenderer.invoke(HOST_CH.secretsStatus),
	saveSecrets: (patch) => ipcRenderer.invoke(HOST_CH.saveSecrets, patch),
	providerOptions: (token) => ipcRenderer.invoke(HOST_CH.providerOptions, token),
	onConnectionsChanged: (cb: (connected: HostStatus[]) => void) => {
		const handler = (_: unknown, connected: HostStatus[]) => cb(connected);
		ipcRenderer.on(HOST_CH.evtConnectionsChanged, handler);
		return () => ipcRenderer.off(HOST_CH.evtConnectionsChanged, handler);
	},
	onInstallLog: (cb: (e: InstallLogEvent) => void) => {
		const handler = (_: unknown, e: InstallLogEvent) => cb(e);
		ipcRenderer.on(HOST_CH.evtInstallLog, handler);
		return () => ipcRenderer.off(HOST_CH.evtInstallLog, handler);
	},
	onCreateProgress: (cb: (e: CreateProgressEvent) => void) => {
		const handler = (_: unknown, e: CreateProgressEvent) => cb(e);
		ipcRenderer.on(HOST_CH.evtCreateProgress, handler);
		return () => ipcRenderer.off(HOST_CH.evtCreateProgress, handler);
	},
};

contextBridge.exposeInMainWorld("ateamHost", host);
