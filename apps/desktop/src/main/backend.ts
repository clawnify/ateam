// The local⇄remote seam. A Backend is one engine the desktop can drive: the
// in-process local engine (dispatcher + engine events) or a remote engine reached
// over SSH (an RpcClient — every call/event goes down the same JSON-RPC wire).
// Both satisfy one shape, so the IPC bridge (ipc.ts) and event forwarding (host.ts)
// don't care which is active — they route to whatever Backend is current.
import type { RpcClient } from "@ateam/protocol";
import { createDispatcher, type Engine } from "@ateam/server";

/** The four engine push-events forwarded to the renderer. */
export type BackendEvent = "taskUpdated" | "loopsUpdated" | "ptyData" | "ptyExit";

export interface Backend {
	readonly kind: "local" | "remote";
	/** The RPC method channels this backend serves (same set for local + remote). */
	readonly methods: readonly string[];
	/** Route one request; the IPC bridge awaits (or ignores, for send channels) this. */
	handle(method: string, args: unknown[]): unknown | Promise<unknown>;
	/** Subscribe to a push-event; returns an unsubscribe. */
	on(event: BackendEvent, cb: (payload: unknown) => void): () => void;
	/** Release transport resources. No-op for local (the engine outlives swaps). */
	dispose(): void;
}

/**
 * A stable indirection the IPC bridge registers against ONCE at startup: its
 * `handle` always routes to whatever Backend is currently active, so connecting
 * to a remote host never re-registers ipcMain channels (which would throw).
 */
export interface Router {
	readonly methods: readonly string[];
	handle(method: string, args: unknown[]): unknown | Promise<unknown>;
}

/** The in-process engine: a dispatcher over it, its own events. Never disposed. */
export function localBackend(engine: Engine): Backend {
	const dispatcher = createDispatcher(engine);
	return {
		kind: "local",
		methods: dispatcher.methods,
		handle: (method, args) => dispatcher.handle(method, args),
		// engine.on is typed per-event; the Backend surface is event-agnostic.
		on: (event, cb) => engine.on(event, cb as never),
		dispose: () => {},
	};
}

/**
 * A remote engine over SSH. `methods` is borrowed from the local dispatcher (the
 * contract is identical on both sides). `dispose` tears down the SSH transport —
 * the remote daemon and its PTY sessions live on, per attach's design.
 */
export function remoteBackend(
	rpc: RpcClient,
	methods: readonly string[],
	dispose: () => void,
): Backend {
	return {
		kind: "remote",
		methods,
		handle: (method, args) => rpc.call(method, args),
		on: (event, cb) => rpc.on(event, cb),
		dispose,
	};
}
