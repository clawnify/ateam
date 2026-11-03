// Serve one client connection: forward the engine's events as notifications and
// answer its requests through the dispatcher. Transport-agnostic — the desktop
// hands it an Electron-IPC connection, the SSH server an stdio one — so every
// client drives the identical engine + dispatcher.
import { randomUUID } from "node:crypto";
import { errorMessage } from "@ateam/git-core";
import {
	CH,
	type ClientFrame,
	NEEDS_PAIRING,
	type PairingState,
	type ServerFrame,
	type SystemInfo,
} from "@ateam/protocol";
import type { Dispatcher } from "./dispatcher";
import type { Engine, EngineEventMap } from "./engine";
import type { Pairings } from "./pairing";

/**
 * The engine events every client is sent, keyed by the engine's own event map:
 * an event added there doesn't compile here until it's forwarded. A hand-kept
 * list once left taskRemoved off, so no client ever heard a box drop a task.
 */
const FORWARDED: Record<keyof EngineEventMap, true> = {
	taskUpdated: true,
	taskRemoved: true,
	loopsUpdated: true,
	ptyData: true,
	ptyExit: true,
};

/** The server's view of a bidirectional, whole-frame message channel. */
export interface ServerTransport {
	send(frame: ServerFrame): void;
	onFrame(handler: (frame: ClientFrame) => void): void;
	/** Optional: fires when the client disconnects, so subscriptions are freed. */
	onClose?(handler: () => void): void;
	/** Optional: drop the client (a revoked device, a box that just locked). */
	close?(): void;
}

/** The box's live network connections, so revoking a device or locking the box
 *  drops the ones it shuts out at once rather than at their next reconnect. */
export class LiveConnections {
	private readonly conns = new Map<
		string,
		{ trusted: boolean; device: string | null; close: () => void }
	>();
	add(id: string, trusted: boolean, close: () => void): void {
		this.conns.set(id, { trusted, device: null, close });
	}
	pair(id: string, device: string): void {
		const c = this.conns.get(id);
		if (c) c.device = device;
	}
	remove(id: string): void {
		this.conns.delete(id);
	}
	/** Every connection of a revoked device. */
	dropDevice(device: string): void {
		for (const c of this.conns.values()) if (c.device === device) c.close();
	}
	/** Every connection that was only in because the box was open. */
	dropUnpaired(except: string): void {
		for (const [id, c] of this.conns) if (id !== except && !c.trusted && !c.device) c.close();
	}
}

/** Failed codes across every connection: past the limit, codes are refused for
 *  a while, so trying them over many connections gets nowhere. */
export class RedeemLimiter {
	private failures: number[] = [];
	constructor(
		private readonly limit = 20,
		private readonly windowMs = 10 * 60 * 1000,
		private readonly now: () => number = Date.now,
	) {}
	blocked(): boolean {
		const since = this.now() - this.windowMs;
		this.failures = this.failures.filter((t) => t > since);
		return this.failures.length >= this.limit;
	}
	fail(): void {
		this.failures.push(this.now());
	}
}

/** The lock on a box's network port (pairing.ts). */
export interface PairingGuard {
	store: Pairings;
	live: LiveConnections;
	limiter: RedeemLimiter;
}

export interface ServeOptions {
	/** Authenticated already (SSH, a local socket): never gated. */
	trusted?: boolean;
	/** The lock; absent, the connection is never gated (the desktop's own engine, tests). */
	pairing?: PairingGuard;
}

/** Wrong tokens or codes on one connection before it is dropped. */
const MAX_CONNECTION_FAILURES = 5;

const PAIRING_METHODS = new Set<string>([
	CH.pairingStatus,
	CH.pairingInvite,
	CH.pairingRedeem,
	CH.pairingRevoke,
	CH.pairingLock,
]);

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
	opts: ServeOptions = {},
): () => void {
	const forward = (event: string) => (payload: unknown) =>
		transport.send({ t: "evt", event, payload });
	const unsubscribe: (() => void)[] = [];
	// One id per connection: the dispatcher tells viewers of the same terminal
	// apart by it (whose size the PTY follows), and forgets them when they go.
	const client = randomUUID();
	let closed = false;

	// The lock (pairing.ts). An unpaired connection to a locked box is sent no
	// events and may only say hello (with a token) or redeem a code.
	const guard = opts.pairing;
	const trusted = opts.trusted === true || !guard;
	let device: string | null = null;
	let admitted = trusted || !guard?.store.locked();
	let failures = 0;
	const subscribeEngine = () => {
		for (const event of Object.keys(FORWARDED) as (keyof EngineEventMap)[])
			unsubscribe.push(engine.on(event, forward(event)));
	};
	if (admitted) subscribeEngine();
	guard?.live.add(client, opts.trusted === true, () => transport.close?.());
	const admit = (id: string) => {
		device = id;
		guard?.live.pair(client, id);
		if (!admitted) {
			admitted = true;
			subscribeEngine();
		}
	};
	const failed = () => {
		if (++failures >= MAX_CONNECTION_FAILURES) transport.close?.();
	};
	const state = (): PairingState =>
		opts.trusted === true
			? { state: "trusted" }
			: device
				? { state: "paired", device }
				: admitted
					? { state: "open" }
					: { state: "needed" };

	const dispose = () => {
		closed = true;
		for (const u of unsubscribe) u();
		dispatcher.release(client);
		guard?.live.remove(client);
	};
	const subscribed = new Set<RpcExtension>();
	const pairingCall = async (g: PairingGuard, method: string, args: unknown[]) => {
		const input = (args[0] ?? {}) as Record<string, unknown>;
		switch (method) {
			case CH.pairingRedeem: {
				if (g.limiter.blocked())
					throw new Error("Too many wrong codes. Wait a few minutes, then ask for a new one.");
				try {
					const grant = g.store.redeem(input.code, input.label, input.kind);
					admit(grant.device.id);
					return grant;
				} catch (e) {
					g.limiter.fail();
					failed();
					throw e;
				}
			}
			case CH.pairingStatus:
				return g.store.status(device);
			case CH.pairingInvite:
				return g.store.invite();
			case CH.pairingRevoke: {
				const id = String(input.id ?? "");
				if (!g.store.revoke(id)) throw new Error("That device isn't paired with this box.");
				// After this reply has gone, in case the device revoked itself.
				setTimeout(() => g.live.dropDevice(id), 0);
				return g.store.status(device === id ? null : device);
			}
			case CH.pairingLock: {
				if (g.store.locked()) throw new Error("This box is locked already.");
				const grant = g.store.lock(input.label, input.kind);
				admit(grant.device.id);
				g.live.dropUnpaired(client);
				return grant;
			}
		}
		throw new Error(`Unknown method: ${method}`);
	};
	const call = async (method: string, args: unknown[]): Promise<unknown> => {
		if (method === CH.systemHello) {
			const token = (args[0] as { token?: unknown } | undefined)?.token;
			if (guard && token !== undefined && opts.trusted !== true) {
				const d = guard.store.verify(token);
				if (d) admit(d.id);
				else if (!admitted) failed();
			}
			const info = (await dispatcher.handle(method, [], { client })) as SystemInfo;
			return guard ? { ...info, pairing: state() } : info;
		}
		if (guard && method === CH.pairingRedeem) return pairingCall(guard, method, args);
		if (!admitted) throw new Error(NEEDS_PAIRING);
		if (guard && PAIRING_METHODS.has(method)) return pairingCall(guard, method, args);
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
