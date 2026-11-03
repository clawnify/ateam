// The links this box holds to other boxes (cross-box, protocol v30), so its
// agents list and message the tasks there and its Lead reaches them.
//
// Each link is a pairing of kind "box" on the box it reaches (pairing.ts). The Mac,
// which holds every box, sets them up (links:set): it asks the other box for a
// one-time code and hands it here, and this box redeems it on its own connection,
// so the token never leaves the two boxes. The other box then holds the link to
// task updates and to reading the board and sending messages (rpc.ts BOX_METHODS).
// On a box that isn't locked there is nothing to redeem: the link connects as any
// device may, and says it is a link, which narrows what it is sent.
//
// Kept in <data dir>/links.json, readable by the owner alone like pairings.json,
// read once at start and written on every change.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type AggregateBackend,
	type BoxLinkDTO,
	type BoxLinksSetDTO,
	CH,
	type ClientTransport,
	createRpcClient,
	pairingClient,
	type RpcClient,
	type SystemInfo,
	type TaskDTO,
	withTimeout,
	wsClientTransport,
} from "@ateam/protocol";
import WebSocket from "ws";
import type { PeerRelay } from "./engine";
import type { PeerSearch, PeerView, SendResult } from "./peer-messages";

export const LINKS_FILE = "links.json";

/** Waits before trying a link again; the last one repeats while it stays down. */
export const LINK_RETRY_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000];

/** How long one call over a link may take: a box gone half-open never answers. */
export const LINK_CALL_TIMEOUT_MS = 10_000;

interface StoredLink {
	name: string;
	url: string;
	token: string | null;
	/** This link's device id on the other box, once paired there. */
	device: string | null;
}

interface LinksFile {
	version: 1;
	/** What the Mac calls this box: how its agents are named on the others. */
	self: string | null;
	links: StoredLink[];
}

export type LinkConnector = (url: string) => { transport: ClientTransport; close(): void };

interface Live {
	stored: StoredLink;
	rpc: RpcClient | null;
	close: (() => void) | null;
	state: BoxLinkDTO["state"];
	reason?: string;
	timer: ReturnType<typeof setTimeout> | null;
	attempt: number;
	stopped: boolean;
	/** The same object for the life of the link, so the Lead's router keeps
	 *  routing a task to it across reconnects. */
	backend: AggregateBackend;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const defaultConnect: LinkConnector = (url) => wsClientTransport(url, WebSocket as never);

export class BoxLinks implements PeerRelay {
	private readonly path: string;
	private readonly connect: LinkConnector;
	private readonly log: (line: string) => void;
	private readonly retryMs: readonly number[];
	private readonly callTimeoutMs: number;
	private self: string | null = null;
	private readonly lives = new Map<string, Live>();
	/** Which link a task lives behind, as the last listings showed. */
	private readonly where = new Map<string, Live>();
	private readonly taskListeners = new Set<(task: TaskDTO, backend: AggregateBackend) => void>();
	private readonly changeListeners = new Set<() => void>();
	/** The links' backends, in the order they were added, for the Lead's router. */
	readonly backends: AggregateBackend[] = [];

	constructor(opts: {
		dataDir: string;
		connect?: LinkConnector;
		log?: (line: string) => void;
		retryMs?: readonly number[];
		callTimeoutMs?: number;
	}) {
		this.path = join(opts.dataDir, LINKS_FILE);
		this.connect = opts.connect ?? defaultConnect;
		this.log = opts.log ?? (() => {});
		this.retryMs = opts.retryMs ?? LINK_RETRY_MS;
		this.callTimeoutMs = opts.callTimeoutMs ?? LINK_CALL_TIMEOUT_MS;
		const f = this.read();
		this.self = f.self;
		for (const stored of f.links) this.add(stored);
	}

	/** Connect every stored link (the daemon's start). */
	start(): void {
		for (const l of this.lives.values()) void this.open(l, null);
	}

	/** links:list: every link and how it is doing. */
	status(): BoxLinkDTO[] {
		return [...this.lives.values()].map((l) => ({
			name: l.stored.name,
			url: l.stored.url,
			state: l.state,
			...(l.reason ? { reason: l.reason } : {}),
			device: l.stored.device,
		}));
	}

	/** links:set: hold exactly these links. One held already (the same url) is
	 *  kept, renamed if need be; a new one, or one given a code, pairs with that
	 *  code first. Answers once each new connection has gone one way or the other. */
	async set(input: unknown): Promise<BoxLinkDTO[]> {
		const req = parseSet(input);
		this.self = req.self;
		const want = new Map(req.links.map((w) => [w.url, w]));
		for (const [url, l] of this.lives) {
			if (want.has(url)) continue;
			this.stop(l);
			this.lives.delete(url);
			this.backends.splice(this.backends.indexOf(l.backend), 1);
			for (const [task, at] of this.where) if (at === l) this.where.delete(task);
		}
		const opening: Promise<void>[] = [];
		for (const w of req.links) {
			const held = this.lives.get(w.url);
			if (!held) {
				const l = this.add({ name: w.name, url: w.url, token: null, device: null });
				opening.push(this.open(l, w.code ?? null));
			} else {
				held.stored.name = w.name;
				if (w.code) opening.push(this.open(held, w.code));
			}
		}
		this.write();
		await Promise.all(opening);
		this.changed();
		return this.status();
	}

	/** The box a backend is, by the name the Mac gave it, or null for none. */
	nameOf(backend: AggregateBackend | undefined): string | null {
		for (const l of this.lives.values()) if (l.backend === backend) return l.stored.name;
		return null;
	}

	/** A linked box's task changed (what the Lead follows its tasks by). */
	onTaskUpdated(cb: (task: TaskDTO, backend: AggregateBackend) => void): () => void {
		this.taskListeners.add(cb);
		return () => this.taskListeners.delete(cb);
	}

	/** The set of links changed (one added or dropped). */
	onChange(cb: () => void): () => void {
		this.changeListeners.add(cb);
		return () => this.changeListeners.delete(cb);
	}

	dispose(): void {
		for (const l of this.lives.values()) this.stop(l);
	}

	// ---- what this box's agents reach through (PeerRelay) ----

	active(): boolean {
		return this.lives.size > 0;
	}

	async list(search: string | undefined): Promise<{
		peers: (PeerView & { box: string })[];
		more: boolean;
		unreachable: { box: string; reason: string }[];
	}> {
		const peers: (PeerView & { box: string })[] = [];
		const unreachable: { box: string; reason: string }[] = [];
		let more = false;
		const answers = await Promise.all(
			[...this.lives.values()].map(async (l) => {
				try {
					return { l, got: await this.peersOf(l, search) };
				} catch (e) {
					return { l, error: message(e) };
				}
			}),
		);
		for (const a of answers) {
			const box = a.l.stored.name;
			if (!("got" in a) || !a.got) {
				unreachable.push({ box, reason: a.error ?? "it didn't answer" });
				continue;
			}
			if (a.got.more) more = true;
			for (const p of a.got.peers) {
				const { you: _you, ...view } = p;
				peers.push({ ...view, box });
				this.where.set(p.taskId, a.l);
			}
		}
		return { peers, more, unreachable };
	}

	async find(to: string): Promise<{ box: string; taskId: string } | { box: null; reason: string }> {
		const known = this.where.get(to);
		if (known?.rpc && this.lives.get(known.stored.url) === known)
			return { box: known.stored.name, taskId: to };
		const want = to.toLowerCase();
		const hits: { l: Live; taskId: string }[] = [];
		const unreachable: string[] = [];
		await Promise.all(
			[...this.lives.values()].map(async (l) => {
				try {
					const got = await this.peersOf(l, undefined);
					for (const p of got.peers) {
						this.where.set(p.taskId, l);
						if (p.taskId === to || p.name.toLowerCase() === want || p.branch.toLowerCase() === want)
							hits.push({ l, taskId: p.taskId });
					}
				} catch {
					unreachable.push(l.stored.name);
				}
			}),
		);
		const [hit] = hits;
		if (hits.length === 1 && hit) return { box: hit.l.stored.name, taskId: hit.taskId };
		if (hits.length > 1)
			return {
				box: null,
				reason: `"${to}" matches tasks on several boxes (${hits.map((h) => h.l.stored.name).join(", ")}); use a task id from list_peers`,
			};
		const asked = unreachable.length > 0 ? `. Couldn't ask: ${unreachable.join(", ")}` : "";
		return {
			box: null,
			reason: `no task "${to}" on this box or the boxes it links to; call list_peers for ids${asked}`,
		};
	}

	async deliver(
		box: string,
		msg: {
			to: string;
			body: string;
			hop: number;
			from: { taskId: string; name: string; agent: string; lead?: boolean };
		},
	): Promise<SendResult> {
		const l = [...this.lives.values()].find((x) => x.stored.name === box);
		if (!l?.rpc)
			return { ok: false, reason: `the box ${box} can't be reached right now; try again later` };
		try {
			const res = (await withTimeout(
				l.rpc.call(CH.peersSendFromBox, [
					{
						to: msg.to,
						body: msg.body,
						hop: msg.hop,
						from: { ...msg.from, box: this.self ?? "another box" },
					},
				]),
				this.callTimeoutMs,
				"the message",
			)) as SendResult;
			return { ok: res.ok, reason: `on the box ${box}: ${res.reason}` };
		} catch (e) {
			return { ok: false, reason: `the box ${box} didn't take it: ${message(e)}` };
		}
	}

	/** The Lead here messages a task on the linked box behind `backend`. It goes as
	 *  a message from this box's Lead, which that box weighs as a colleague's
	 *  request: a link never speaks with the user's own weight. */
	asLead(backend: AggregateBackend, to: string, body: string): Promise<SendResult> {
		const name = this.nameOf(backend);
		if (!name) return Promise.resolve({ ok: false, reason: "that box isn't linked any more" });
		return this.deliver(name, {
			to,
			body,
			hop: 1,
			from: { taskId: "lead", name: "Lead", agent: "Lead", lead: true },
		});
	}

	// ---- connections ----

	private add(stored: StoredLink): Live {
		const l: Live = {
			stored,
			rpc: null,
			close: null,
			state: "connecting",
			timer: null,
			attempt: 0,
			stopped: false,
			backend: {
				kind: "remote",
				handle: (method, args) => {
					if (!l.rpc) throw new Error(`The box ${l.stored.name} can't be reached right now.`);
					return withTimeout(l.rpc.call(method, args), this.callTimeoutMs, method);
				},
			},
		};
		this.lives.set(stored.url, l);
		this.backends.push(l.backend);
		return l;
	}

	private async peersOf(
		l: Live,
		search: string | undefined,
	): Promise<{ peers: PeerView[]; more: boolean }> {
		if (!l.rpc) throw new Error(l.reason ?? "not connected");
		const got = (await withTimeout(
			l.rpc.call(CH.peersList, [search ? { search } : {}]),
			this.callTimeoutMs,
			"its tasks",
		)) as PeerView[] | PeerSearch;
		return Array.isArray(got) ? { peers: got, more: false } : got;
	}

	/** Connect (again), pairing first with `code` when the Mac handed one over. */
	private async open(l: Live, code: string | null): Promise<void> {
		if (l.timer) clearTimeout(l.timer);
		l.timer = null;
		l.close?.();
		l.rpc = null;
		l.state = "connecting";
		let conn: ReturnType<LinkConnector>;
		try {
			conn = this.connect(l.stored.url);
		} catch (e) {
			return this.down(l, "unreachable", message(e));
		}
		const rpc = createRpcClient(conn.transport);
		l.close = conn.close;
		let up = false;
		conn.transport.onClose?.(() => {
			// Only the connection this link is on now: an earlier one closing late is old news.
			if (l.close !== conn.close || l.stopped) return;
			l.rpc = null;
			if (up) this.down(l, "unreachable", "the connection dropped");
		});
		try {
			const hello = (await withTimeout(
				rpc.call(CH.systemHello, [
					{ link: true, ...(l.stored.token ? { token: l.stored.token } : {}) },
				]),
				this.callTimeoutMs,
				"the box",
			)) as SystemInfo;
			if (code) {
				const grant = await withTimeout(
					pairingClient(rpc).redeem(code, this.self ?? "box", "box"),
					this.callTimeoutMs,
					"pairing",
				);
				l.stored.token = grant.token;
				l.stored.device = grant.device.id;
				this.write();
			} else if (hello.pairing?.state === "needed") {
				conn.close();
				return this.down(
					l,
					"refused",
					"It's locked to its paired devices, and this link isn't one of them. Turning cross-box off and on again on the Mac pairs it.",
				);
			}
			if (l.close !== conn.close || l.stopped) return;
			l.rpc = rpc;
			l.state = "connected";
			l.reason = undefined;
			l.attempt = 0;
			up = true;
			rpc.on("taskUpdated", (task) => {
				for (const cb of this.taskListeners) cb(task as TaskDTO, l.backend);
			});
			this.log(`[ateam] linked to ${l.stored.name}`);
		} catch (e) {
			conn.close();
			if (l.close !== conn.close || l.stopped) return;
			this.down(l, code ? "refused" : "unreachable", message(e));
		}
	}

	/** Not connected, and why; try again later unless it was dropped. */
	private down(l: Live, state: "unreachable" | "refused", reason: string): void {
		l.rpc = null;
		l.state = state;
		l.reason = reason;
		if (l.stopped) return;
		const wait = this.retryMs[Math.min(l.attempt, this.retryMs.length - 1)] ?? 60_000;
		l.attempt++;
		l.timer = setTimeout(() => void this.open(l, null), wait);
		l.timer.unref?.();
	}

	private stop(l: Live): void {
		l.stopped = true;
		if (l.timer) clearTimeout(l.timer);
		l.timer = null;
		l.close?.();
		l.close = null;
		l.rpc = null;
	}

	private changed(): void {
		for (const cb of this.changeListeners) cb();
	}

	// ---- the file ----

	private read(): LinksFile {
		const empty: LinksFile = { version: 1, self: null, links: [] };
		if (!existsSync(this.path)) return empty;
		try {
			const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<LinksFile>;
			const links = Array.isArray(raw.links) ? raw.links.filter(isStored) : [];
			return { version: 1, self: typeof raw.self === "string" ? raw.self : null, links };
		} catch (e) {
			this.log(`[ateam] ${LINKS_FILE} is unreadable, so this box holds no links: ${message(e)}`);
			return empty;
		}
	}

	private write(): void {
		const f: LinksFile = {
			version: 1,
			self: this.self,
			links: [...this.lives.values()].map((l) => l.stored),
		};
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, this.path);
		chmodSync(this.path, 0o600);
	}
}

function isStored(v: unknown): v is StoredLink {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.name === "string" &&
		typeof o.url === "string" &&
		(o.token === null || typeof o.token === "string") &&
		(o.device === null || typeof o.device === "string")
	);
}

/** links:set's input, checked: it comes over the network. */
function parseSet(input: unknown): BoxLinksSetDTO {
	const o = (input ?? {}) as Record<string, unknown>;
	const self = typeof o.self === "string" ? o.self.trim().slice(0, 100) : "";
	if (!self) throw new Error("Say what this box is called (self).");
	if (!Array.isArray(o.links)) throw new Error("links must be a list.");
	const links: BoxLinksSetDTO["links"] = [];
	for (const raw of o.links) {
		const w = (raw ?? {}) as Record<string, unknown>;
		const name = typeof w.name === "string" ? w.name.trim().slice(0, 100) : "";
		const url = typeof w.url === "string" ? w.url.trim() : "";
		if (!name || !/^wss?:\/\/[^\s/]+(\/\S*)?$/.test(url))
			throw new Error(`A link needs a name and a ws:// address (got "${name}", "${url}").`);
		const code = typeof w.code === "string" && w.code.trim() ? w.code.trim() : null;
		if (!links.some((x) => x.url === url)) links.push({ name, url, code });
	}
	return { self, links };
}
