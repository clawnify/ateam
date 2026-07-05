// Transport-agnostic RPC framing for driving the engine from a client — the
// same wire the desktop's Electron IPC and the SSH stdio channel both carry.
// Requests correlate to responses by id; the server pushes engine events as
// notifications. PTY bytes ride as `evt` payloads (already base64 in the daemon
// protocol), so there is one framed channel, not a special-cased binary lane.

export interface RpcRequest {
	t: "req";
	id: number;
	method: string;
	args: unknown[];
}
export type RpcResponse =
	| { t: "res"; id: number; ok: true; result: unknown }
	| { t: "res"; id: number; ok: false; error: string };
export interface RpcEvent {
	t: "evt";
	event: string;
	payload: unknown;
}
/** Frames the server sends to the client. */
export type ServerFrame = RpcResponse | RpcEvent;
/** Frames the client sends to the server. */
export type ClientFrame = RpcRequest;

/**
 * The client's view of a bidirectional, whole-frame message channel — Electron
 * IPC, an SSH stdio pipe, or a WebSocket. Framing/serialization is the
 * transport's job; this layer only deals in decoded frames.
 */
export interface ClientTransport {
	send(frame: ClientFrame): void;
	onFrame(handler: (frame: ServerFrame) => void): void;
	/** Optional: fires when the channel drops, so in-flight calls can reject. */
	onClose?(handler: () => void): void;
}

export interface RpcClient {
	/** Invoke an engine method; resolves with its result or rejects on error. */
	call(method: string, args?: unknown[]): Promise<unknown>;
	/** Subscribe to a server event (taskUpdated, ptyData, …); returns unsubscribe. */
	on(event: string, handler: (payload: unknown) => void): () => void;
}

export function createRpcClient(transport: ClientTransport): RpcClient {
	let nextId = 1;
	const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	const listeners = new Map<string, Set<(payload: unknown) => void>>();

	transport.onFrame((frame) => {
		if (frame.t === "res") {
			const p = pending.get(frame.id);
			if (!p) return;
			pending.delete(frame.id);
			if (frame.ok) p.resolve(frame.result);
			else p.reject(new Error(frame.error));
		} else {
			const set = listeners.get(frame.event);
			if (set) for (const l of [...set]) l(frame.payload);
		}
	});

	transport.onClose?.(() => {
		for (const p of pending.values()) p.reject(new Error("RPC connection closed"));
		pending.clear();
	});

	return {
		call(method, args = []) {
			const id = nextId++;
			return new Promise<unknown>((resolve, reject) => {
				pending.set(id, { resolve, reject });
				// shortcut: no per-call timeout. onClose rejects in-flight calls when
				// the channel drops; add a timeout once the SSH transport lands, where
				// a lost reply on a still-open socket would otherwise hang forever.
				transport.send({ t: "req", id, method, args });
			});
		},
		on(event, handler) {
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
			}
			set.add(handler);
			return () => {
				set.delete(handler);
			};
		},
	};
}
