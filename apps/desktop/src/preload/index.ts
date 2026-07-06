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
import { type AteamHost, HOST_CH, type HostStatus } from "../shared/host";

const api: AteamApi = {
	projects: {
		pick: () => ipcRenderer.invoke(CH.projectsPick),
		register: (repoPath, opts) => ipcRenderer.invoke(CH.projectsRegister, repoPath, opts),
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
	fs: {
		listDir: (path) => ipcRenderer.invoke(CH.fsListDir, path),
	},
	loops: {
		list: () => ipcRenderer.invoke(CH.loopsList),
		setEnabled: (id, enabled) => ipcRenderer.invoke(CH.loopsSetEnabled, id, enabled),
		runNow: (id) => ipcRenderer.invoke(CH.loopsRunNow, id),
		templates: () => ipcRenderer.invoke(CH.loopsTemplates),
		create: (input) => ipcRenderer.invoke(CH.loopsCreate, input),
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
		stageClipboardImage: () => ipcRenderer.invoke(CH.utilStageImage),
		stageImagePath: (path) => ipcRenderer.invoke(CH.utilStageImagePath, path),
		writeImageBytes: (base64, ext) => ipcRenderer.invoke(CH.utilWriteImageBytes, base64, ext),
	},
	events: {
		onTaskUpdated: (cb: (task: TaskDTO) => void) => {
			const handler = (_: unknown, task: TaskDTO) => cb(task);
			ipcRenderer.on(CH.evtTaskUpdated, handler);
			return () => ipcRenderer.off(CH.evtTaskUpdated, handler);
		},
	},
};

contextBridge.exposeInMainWorld("ateam", api);

// The connection-control surface (which engine drives the app) — separate from
// window.ateam (the engine itself). See apps/desktop/src/shared/host.ts.
const host: AteamHost = {
	list: () => ipcRenderer.invoke(HOST_CH.list),
	connect: (alias) => ipcRenderer.invoke(HOST_CH.connect, alias),
	current: () => ipcRenderer.invoke(HOST_CH.current),
	onChanged: (cb: (status: HostStatus) => void) => {
		const handler = (_: unknown, status: HostStatus) => cb(status);
		ipcRenderer.on(HOST_CH.evtChanged, handler);
		return () => ipcRenderer.off(HOST_CH.evtChanged, handler);
	},
};

contextBridge.exposeInMainWorld("ateamHost", host);
