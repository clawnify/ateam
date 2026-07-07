// @ateam/server — the Ateam engine: git worktrees, agent PTYs, board state,
// hooks, loops, and the merge queue. Electron-free and transport-agnostic, so
// the desktop shell today and the SSH-reachable server later share one engine.
//
// Public API: build the engine, then a dispatcher over it. Each transport
// (Electron ipcMain today, JSON-RPC over SSH next) forwards the engine's events
// and adapts its own request channel to dispatcher.handle().

export type { ConnectionDTO, ConnectionRecord, SshHost } from "./connections";
export { listConnections, readSshHosts, recordConnection } from "./connections";
export type { Dispatcher } from "./dispatcher";
export { createDispatcher } from "./dispatcher";
export type { Engine, EngineOptions } from "./engine";
export { createEngine } from "./engine";
export type { ServerTransport } from "./rpc";
export { serveRpc } from "./rpc";
export type { Services } from "./services";
export { socketClientTransport, socketServerTransport } from "./transport/socket";
export type { SshClient, SshOptions } from "./transport/ssh";
export { sshClientTransport } from "./transport/ssh";
export { streamClientTransport, streamServerTransport } from "./transport/stream";
export { wsServerTransport } from "./transport/ws";
