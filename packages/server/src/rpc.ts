// Serve one client connection: forward the engine's events as notifications and
// answer its requests through the dispatcher. Transport-agnostic — the desktop
// hands it an Electron-IPC connection, the SSH server an stdio one — so every
// client drives the identical engine + dispatcher.
import { randomUUID } from "node:crypto";
import { errorMessage } from "@ateam/git-core";
import type { ClientFrame, ServerFrame } from "@ateam/protocol";
import type { Dispatcher } from "./dispatcher";
import type { Engine } from "./engine";

/** The server's view of a bidirectional, whole-frame message channel. */
export interface ServerTransport {
	send(frame: ServerFrame): void;
	onFrame(handler: (frame: ClientFrame) => void): void;
	/** Optional: fires when the client disconnects, so subscriptions are freed. */
	onClose?(handler: () => void): void;
}

/**
 * Methods served beside the dispatcher's, with events of their own (a box's
 * Lead, lead/engine-lead.ts). A connection gets those events only once it has
 * called one of the methods, so a client that never uses the extension (the
 * desktop over SSH) is never sent them.
 */
export interface RpcExtension {
	readonly methods: readonly string[];
	handle(method: string, args: unknown[]): Promise<unknown>;
	/** Start pushing this connection the extension's events; returns the stop. */
	subscribe(send: (event: string, payload: unknown) => void): () => void;
}

/**
 * Wire an engine + dispatcher to one client connection. Returns a cleanup that
 * removes the event subscriptions — call it (or fire the transport's onClose)
 * when the client goes away, so a dropped client never leaks listeners or keeps
 * pushing into a dead channel. The engine and its PTY sessions live on.
 */
export function serveRpc(
	engine: Engine,
	dispatcher: Dispatcher,
	transport: ServerTransport,
	extensions: readonly RpcExtension[] = [],
): () => void {
	const forward = (event: string) => (payload: unknown) =>
		transport.send({ t: "evt", event, payload });
	const unsubscribe = [
		engine.on("taskUpdated", forward("taskUpdated")),
		engine.on("loopsUpdated", forward("loopsUpdated")),
		engine.on("ptyData", forward("ptyData")),
		engine.on("ptyExit", forward("ptyExit")),
	];
	// One id per connection: the dispatcher tells viewers of the same terminal
	// apart by it (whose size the PTY follows), and forgets them when they go.
	const client = randomUUID();
	let closed = false;
	const dispose = () => {
		closed = true;
		for (const u of unsubscribe) u();
		dispatcher.release(client);
	};
	const subscribed = new Set<RpcExtension>();
	const call = (method: string, args: unknown[]): Promise<unknown> => {
		const ext = extensions.find((x) => x.methods.includes(method));
		if (!ext) return dispatcher.handle(method, args, { client });
		// Before the call, so nothing pushed while it runs is missed (a snapshot
		// then the events after it).
		if (!subscribed.has(ext) && !closed) {
			subscribed.add(ext);
			unsubscribe.push(
				ext.subscribe((event, payload) => transport.send({ t: "evt", event, payload })),
			);
		}
		return ext.handle(method, args);
	};

	transport.onFrame(async (frame) => {
		if (frame.t !== "req") return;
		try {
			const result = await call(frame.method, frame.args);
			transport.send({ t: "res", id: frame.id, ok: true, result });
		} catch (err) {
			transport.send({ t: "res", id: frame.id, ok: false, error: errorMessage(err) });
		}
	});
	transport.onClose?.(dispose);
	return dispose;
}
