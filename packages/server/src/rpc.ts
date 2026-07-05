// Serve one client connection: forward the engine's events as notifications and
// answer its requests through the dispatcher. Transport-agnostic — the desktop
// hands it an Electron-IPC connection, the SSH server an stdio one — so every
// client drives the identical engine + dispatcher.
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
 * Wire an engine + dispatcher to one client connection. Returns a cleanup that
 * removes the event subscriptions — call it (or fire the transport's onClose)
 * when the client goes away, so a dropped client never leaks listeners or keeps
 * pushing into a dead channel. The engine and its PTY sessions live on.
 */
export function serveRpc(
	engine: Engine,
	dispatcher: Dispatcher,
	transport: ServerTransport,
): () => void {
	const forward = (event: string) => (payload: unknown) =>
		transport.send({ t: "evt", event, payload });
	const unsubscribe = [
		engine.on("taskUpdated", forward("taskUpdated")),
		engine.on("loopsUpdated", forward("loopsUpdated")),
		engine.on("ptyData", forward("ptyData")),
		engine.on("ptyExit", forward("ptyExit")),
	];
	const dispose = () => {
		for (const u of unsubscribe) u();
	};

	transport.onFrame(async (frame) => {
		if (frame.t !== "req") return;
		try {
			const result = await dispatcher.handle(frame.method, frame.args);
			transport.send({ t: "res", id: frame.id, ok: true, result });
		} catch (err) {
			transport.send({ t: "res", id: frame.id, ok: false, error: errorMessage(err) });
		}
	});
	transport.onClose?.(dispose);
	return dispose;
}
