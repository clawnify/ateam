// @ateam/server — the Ateam engine: git worktrees, agent PTYs, board state,
// hooks, loops, and the merge queue. Electron-free and transport-agnostic, so
// the desktop shell today and the SSH-reachable server later share one engine.
//
// Public API: build the engine, then a dispatcher over it. Each transport
// (Electron ipcMain today, JSON-RPC over SSH next) forwards the engine's events
// and adapts its own request channel to dispatcher.handle().

export type { ConnectionDTO, ConnectionRecord, HostTransport, SshHost } from "./connections";
export {
	boxSnapshotOf,
	boxWakeOf,
	endpointUrl,
	forgetConnection,
	listConnections,
	readSshHosts,
	recordConnection,
	resolveTransport,
	saveBoxSnapshot,
	sleepingAliases,
} from "./connections";
export type { CallContext, Dispatcher } from "./dispatcher";
export { createDispatcher } from "./dispatcher";
export type { Engine, EngineOptions } from "./engine";
export { createEngine } from "./engine";
export type { GrammarJudgeIssue, GrammarVerdict } from "./grammar-jev";
export { judgeGrammar } from "./grammar-jev";
export type { JsonRpcMessage, McpReply, McpToolResult, McpToolServer } from "./hooks/board-mcp";
export { dispatchMcpTools } from "./hooks/board-mcp";
// The Lead chat asks before its own agent uses a tool, in the same words.
export { describeAsk, ruleText } from "./permissions";
export type { BoxProvider, CreatedServer, CreateServerInput, ProviderOptions } from "./provision";
export {
	buildCloudInit,
	HETZNER_LOCATIONS,
	HETZNER_SIZES,
	hetznerProvider,
} from "./provision";
export type { ServerTransport } from "./rpc";
export { serveRpc } from "./rpc";
export type { Services } from "./services";
export { socketClientTransport, socketServerTransport } from "./transport/socket";
export type { SshClient, SshExecOptions, SshExecResult, SshOptions } from "./transport/ssh";
export { sshClientTransport, sshExec } from "./transport/ssh";
export { streamClientTransport, streamServerTransport } from "./transport/stream";
export { wsServerTransport } from "./transport/ws";
export {
	DEFAULT_SETTINGS,
	readSettings,
	SETTINGS_VERSION,
	settingsPath,
	updateSettings,
} from "./settings-file";
export { credentialsPath, openRouterApiKey } from "./credentials-file";
