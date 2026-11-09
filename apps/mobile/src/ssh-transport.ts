import type { ClientTransport, ServerFrame } from "@ateam/protocol";
import type { SSHNative } from "../modules/expo-ssh/src";

/** The native core emits complete UTF-8 lines, keeping stderr separate. Subscribe
 * before attaching: the first frame or an early remote exit must not be lost. */
export function sshTransport(native: SSHNative, id: string) {
	let closed = false;
	let reason = "SSH connection closed";
	let onFrame: ((frame: ServerFrame) => void) | null = null;
	const onClose = new Set<() => void>();
	const waiting: ServerFrame[] = [];
	let waitingSize = 0;
	const subscriptions: { remove(): void }[] = [];
	const close = (message = reason) => {
		if (closed) return;
		closed = true;
		reason = message;
		for (const s of subscriptions) s.remove();
		waiting.length = 0;
		waitingSize = 0;
		void native.close(id).catch(() => {});
		for (const handler of onClose) handler();
		onClose.clear();
	};
	subscriptions.push(
		native.addListener("line", (e) => {
			if (closed || e.id !== id || !e.line) return;
			try {
				const frame = JSON.parse(e.line) as ServerFrame;
				if (!frame || (frame.t !== "res" && frame.t !== "evt"))
					throw new Error("Invalid SSH protocol frame");
				if (
					frame.t === "res"
						? !Number.isSafeInteger(frame.id) ||
							typeof frame.ok !== "boolean" ||
							(!frame.ok && typeof frame.error !== "string")
						: typeof frame.event !== "string"
				)
					throw new Error("Invalid SSH protocol frame");
				if (onFrame) onFrame(frame);
				else if (waiting.length < 64 && waitingSize + e.line.length <= 8 * 1024 * 1024) {
					waitingSize += e.line.length;
					waiting.push(frame);
				} else close("Too many SSH frames before the client was ready");
			} catch {
				close("Invalid data from Ateam over SSH");
			}
		}),
	);
	subscriptions.push(
		native.addListener("closed", (e) => {
			if (e.id === id) close(e.message);
		}),
	);
	// Serialize bridge writes. Async actor calls alone do not establish invocation order.
	let writes = Promise.resolve();
	let queued = 0;
	const transport: ClientTransport = {
		send(frame) {
			if (closed) throw new Error(reason);
			const line = JSON.stringify(frame);
			queued += line.length;
			if (queued > 32 * 1024 * 1024) {
				close("SSH output queue is full");
				throw new Error(reason);
			}
			writes = writes
				.then(async () => {
					try {
						if (!closed) await native.write(id, line);
					} finally {
						queued -= line.length;
					}
				})
				.catch((e) => close(e instanceof Error ? e.message : String(e)));
		},
		onFrame(handler) {
			onFrame = handler;
			waitingSize = 0;
			for (const frame of waiting.splice(0)) handler(frame);
			return () => {
				onFrame = null;
			};
		},
		onClose(handler) {
			if (closed) handler();
			else onClose.add(handler);
			return () => {
				onClose.delete(handler);
			};
		},
	};
	return {
		transport,
		close,
		async start() {
			try {
				await native.attach(id);
				if (closed) throw new Error(reason);
			} catch (e) {
				close();
				throw e;
			}
		},
		async httpUrl(port: number) {
			if (closed) throw new Error(reason);
			return `http://127.0.0.1:${await native.forward(id, port)}`;
		},
	};
}
