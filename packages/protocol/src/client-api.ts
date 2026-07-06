// Bind the AteamApi surface to an RpcClient — the client-side mirror of the
// desktop preload's `window.ateam`, but over any transport (SSH stdio, a socket,
// a WebSocket) instead of Electron IPC. Every request becomes an rpc.call(CH.x);
// every push event (taskUpdated/loopsUpdated/ptyData/ptyExit) an rpc.on(...).
//
// It returns a *total* AteamApi by taking a `native` adapter for the handful of
// methods that are inherently client-local — a native file dialog, the OS
// clipboard, webUtils' path-for-a-dropped-File — which no remote engine can
// serve. Local-desktop supplies these from Electron; a remote client supplies
// them from its own OS (or, later, from server-fs RPC helpers).
import type {
	AgentDTO,
	AteamApi,
	CleanupCandidate,
	CleanupReport,
	CreateLoopInput,
	DiffResultDTO,
	DirListingDTO,
	GitStatusSnapshot,
	KanbanColumn,
	LoopDTO,
	LoopTemplateDTO,
	MergeEnqueueDTO,
	MergeStrategy,
	ProjectDTO,
	PtyDataEvent,
	PtyExitEvent,
	PtySnapshot,
	SessionDTO,
	SystemInfo,
	TaskDTO,
	UpdateResultDTO,
} from "./index";
import { CH } from "./index";
import type { RpcClient } from "./rpc";

/**
 * The connect-time handshake: ask the engine its protocol version + agents. Call
 * this on the raw RpcClient BEFORE building the full api, and compare
 * `info.protocolVersion` against `PROTOCOL_VERSION` to gate a version-skewed
 * remote. It's a low-level connect primitive, deliberately not on AteamApi.
 */
export function serverHandshake(rpc: RpcClient): Promise<SystemInfo> {
	return rpc.call(CH.systemHello) as Promise<SystemInfo>;
}

/**
 * The client-local slice of AteamApi — methods that touch the *client's* OS, not
 * the engine: the native folder/file dialogs, the clipboard image staging, and
 * webUtils' synchronous path-for-a-File. The host that owns the real device
 * (Electron main today) provides these; everything else flows over RPC.
 */
export interface NativeClientApi {
	pathForFile(file: File): string;
	pick(): Promise<string | null>;
	pickFiles(): Promise<string[]>;
	stageClipboardImage(): Promise<boolean>;
	stageImagePath(path: string): Promise<boolean>;
}

/** Build the full AteamApi over an RpcClient, delegating client-local bits to `native`. */
export function buildAteamApi(rpc: RpcClient, native: NativeClientApi): AteamApi {
	// Typed thin wrapper: rpc.call is Promise<unknown>; each method fixes its type.
	const call = <T>(method: string, args: unknown[] = []): Promise<T> =>
		rpc.call(method, args) as Promise<T>;

	return {
		projects: {
			pick: native.pick,
			register: (repoPath, opts) => call<ProjectDTO>(CH.projectsRegister, [repoPath, opts]),
			list: () => call<ProjectDTO[]>(CH.projectsList),
			remove: (id) => call<void>(CH.projectsRemove, [id]),
		},
		tasks: {
			list: (projectId) => call<TaskDTO[]>(CH.tasksList, [projectId]),
			create: (input) => call<TaskDTO>(CH.tasksCreate, [input]),
			remove: (input) => call<void>(CH.tasksRemove, [input]),
			setColumn: (id, column: KanbanColumn) => call<TaskDTO>(CH.tasksSetColumn, [id, column]),
			cleanupPreview: (projectId) => call<CleanupReport>(CH.tasksCleanupPreview, [projectId]),
			cleanupCandidates: (projectId) =>
				call<CleanupCandidate[]>(CH.tasksCleanupCandidates, [projectId]),
			cleanup: (projectId) => call<CleanupReport>(CH.tasksCleanup, [projectId]),
		},
		git: {
			commit: (taskId, message) => call<{ sha: string }>(CH.gitCommit, [taskId, message]),
			push: (taskId) => call<void>(CH.gitPush, [taskId]),
			update: (taskId) => call<UpdateResultDTO>(CH.gitUpdate, [taskId]),
			merge: (taskId, strategy: MergeStrategy) =>
				call<MergeEnqueueDTO>(CH.gitMerge, [taskId, strategy]),
			diff: (taskId) => call<DiffResultDTO>(CH.gitDiff, [taskId]),
			fileDiff: (taskId, file) => call<string>(CH.gitFileDiff, [taskId, file]),
			status: (taskId) => call<GitStatusSnapshot>(CH.gitStatus, [taskId]),
		},
		agents: {
			list: () => call<AgentDTO[]>(CH.agentsList),
		},
		fs: {
			listDir: (path) => call<DirListingDTO>(CH.fsListDir, [path]),
		},
		loops: {
			list: () => call<LoopDTO[]>(CH.loopsList),
			setEnabled: (id, enabled) => call<LoopDTO[]>(CH.loopsSetEnabled, [id, enabled]),
			runNow: (id) => call<LoopDTO[]>(CH.loopsRunNow, [id]),
			templates: () => call<LoopTemplateDTO[]>(CH.loopsTemplates),
			create: (input: CreateLoopInput) => call<LoopDTO[]>(CH.loopsCreate, [input]),
			remove: (id) => call<LoopDTO[]>(CH.loopsDelete, [id]),
			onUpdated: (cb) => rpc.on("loopsUpdated", (p) => cb(p as LoopDTO[])),
		},
		pty: {
			spawnAgent: (input) => call<{ terminalId: string }>(CH.ptySpawnAgent, [input]),
			spawnShell: (input) => call<{ terminalId: string }>(CH.ptySpawnShell, [input]),
			// Fire-and-forget in the API; over RPC each still gets a (tiny) ack frame.
			// shortcut: per-keystroke ptyWrite pays a round-trip ack. Fine over SSH
			// (bytes are tiny); add a one-way "notify" frame if it ever shows latency.
			write: (terminalId, data) => void call<void>(CH.ptyWrite, [terminalId, data]),
			resize: (terminalId, cols, rows) => void call<void>(CH.ptyResize, [terminalId, cols, rows]),
			kill: (terminalId) => void call<void>(CH.ptyKill, [terminalId]),
			snapshot: (terminalId) => call<PtySnapshot>(CH.ptySnapshot, [terminalId]),
			listForTask: (taskId) => call<SessionDTO[]>(CH.ptyListForTask, [taskId]),
			onData: (cb) => rpc.on("ptyData", (p) => cb(p as PtyDataEvent)),
			onExit: (cb) => rpc.on("ptyExit", (p) => cb(p as PtyExitEvent)),
		},
		events: {
			onTaskUpdated: (cb) => rpc.on("taskUpdated", (p) => cb(p as TaskDTO)),
		},
		utils: {
			pathForFile: native.pathForFile,
			pickFiles: native.pickFiles,
			stageClipboardImage: native.stageClipboardImage,
			stageImagePath: native.stageImagePath,
			writeImageBytes: (base64, ext) => call<string>(CH.utilWriteImageBytes, [base64, ext]),
		},
	};
}
