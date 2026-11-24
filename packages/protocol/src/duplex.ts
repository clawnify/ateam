// A second RPC session, the other way round, over a connection one end opened.
//
// The Mac opens every connection to a box and can't be dialled back: it sleeps,
// it has no listener, and a tailnet's rules may let no box reach it. So for a box
// to read the Mac's board and message its tasks, the box calls back down that
// same connection: on this second session the box is the client and the Mac the
// server. Its frames travel wrapped as `{ t: "back", frame }`, and an end that
// predates them drops them unread (a client ignores a frame that is no response
// and names no event it listens for, rpc.ts; a server ignores anything that is no
// request, packages/server/src/rpc.ts).

import type { ClientFrame, ClientTransport, ServerFrame } from "./rpc";

/** The serving end of a connection, as serveRpc takes it (packages/server). */
export interface ServerEndTransport {
	send(frame: ServerFrame): void;
	onFrame(handler: (frame: ClientFrame) => void): void;
	onClose?(handler: () => void): void;
	close?(): void;
}

type AnyFrame = (frame: unknown) => void;

/** One reader on the connection, handing each frame to the session it is for. */
function fork(base: { onFrame(handler: never): void }): {
	main: AnyFrame | null;
	back: AnyFrame | null;
} {
	const to: { main: AnyFrame | null; back: AnyFrame | null } = { main: null, back: null };
	(base.onFrame as (handler: AnyFrame) => void)((frame) => {
		const f = frame as { t?: unknown; frame?: unknown } | null;
		if (f?.t !== "back") return to.main?.(frame);
		if (f.frame && typeof f.frame === "object") to.back?.(f.frame);
	});
	return to;
}

/** The end that opened the connection: its own session as before (`main`), and
 *  the serving end of the session the other side opens back (`back`). */
export function splitClientTransport(base: ClientTransport): {
	main: ClientTransport;
	back: ServerEndTransport;
} {
	const to = fork(base);
	const send = base.send as AnyFrame;
	const onClose = base.onClose ? (handler: () => void) => base.onClose?.(handler) : undefined;
	return {
		main: {
			send: (frame) => base.send(frame),
			onFrame: (handler) => {
				to.main = handler as AnyFrame;
			},
			...(onClose ? { onClose } : {}),
		},
		back: {
			send: (frame) => send({ t: "back", frame }),
			onFrame: (handler) => {
				to.back = handler as AnyFrame;
			},
			...(onClose ? { onClose } : {}),
		},
	};
}

/** The end that accepted the connection: the session it serves as before
 *  (`main`), and a client's end for the session it opens back (`back`). */
export function splitServerTransport(base: ServerEndTransport): {
	main: ServerEndTransport;
	back: ClientTransport;
} {
	const to = fork(base);
	const send = base.send as AnyFrame;
	const onClose = base.onClose ? (handler: () => void) => base.onClose?.(handler) : undefined;
	return {
		main: {
			send: (frame) => base.send(frame),
			onFrame: (handler) => {
				to.main = handler as AnyFrame;
			},
			...(onClose ? { onClose } : {}),
			...(base.close ? { close: () => base.close?.() } : {}),
		},
		back: {
			send: (frame) => send({ t: "back", frame }),
			onFrame: (handler) => {
				to.back = handler as AnyFrame;
			},
			...(onClose ? { onClose } : {}),
		},
	};
}
