// The desktop's main Lead chat when it lives on a box (`client.leadBox`): that
// box's own Lead (packages/server/src/lead/engine-lead.ts), reached over the
// connection the desktop already holds (Host.boxLink). The phone talks to the
// same one when it picks that box, so both show one conversation, live.
//
// What needs this Mac happens here. A file attached by its path is read and sent
// as bytes, since the box can't read the Mac's disk, and the preview of an image
// is made from the Mac's copy and kept by its path on the box, since the Mac
// can't read the box's.
//
// A new connection hears the Lead's events only once it has made a Lead call
// (packages/server/src/rpc.ts), so every time the box comes back this reads the
// conversation again: that read subscribes, and catches up on what was said
// while it wasn't held. Reading never connects or wakes the box; doing
// something in the chat does, as connecting from Settings → Boxes would.
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
	applyLeadEvent,
	boxSupports,
	type LeadAttachResult,
	type LeadClient,
	type LeadEvent,
	type LeadFile,
	type LeadItem,
	type LeadPermissionAnswer,
	type LeadSnapshot,
	leadClient,
	type RpcClient,
} from "@ateam/protocol";

/** The most one file may weigh on its way to the box's Lead (its own cap). */
export const MAX_REMOTE_ATTACH_BYTES = 10 * 1024 * 1024;

/** How many of the latest items a read loads; older ones page in on demand. */
export const REMOTE_TAIL = 200;

/** How long a preview is kept: as long as the box keeps the attachment
 *  (KEEP_MS in packages/server/src/lead/attachments.ts). */
export const PREVIEW_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** Remove previews older than PREVIEW_KEEP_MS: their files are gone from the box. */
export function prunePreviews(dir: string, now = Date.now()): void {
	if (!existsSync(dir)) return;
	for (const name of readdirSync(dir)) {
		const at = join(dir, name);
		try {
			if (now - statSync(at).mtimeMs > PREVIEW_KEEP_MS) rmSync(at, { force: true });
		} catch {
			/* raced or removed: nothing to do */
		}
	}
}

const EMPTY: LeadSnapshot = { items: [], draft: "", busy: false, auto: false };

export interface RemoteLeadDeps {
	/** The box's alias. */
	box: string;
	/** Its connection while held (Host.boxLink), else null. */
	link(): { rpc: RpcClient; version: number } | null;
	/** Connect it, waking it through its provider: a call made while it isn't held. */
	connect(): Promise<void>;
	emit(e: LeadEvent): void;
	/** A small preview of an image on this Mac as a data: URL, or null. */
	preview(source: { path: string } | { bytes: Uint8Array }): Promise<string | null>;
	/** Where previews are kept, by the image's path on the box. */
	previewDir: string;
}

export interface RemoteLead {
	readonly box: string;
	connected(): boolean;
	/** Emoji answers work there (v28). */
	canReact(): boolean;
	snapshot(tail?: number): Promise<LeadSnapshot>;
	older(beforeId: string, limit: number): Promise<{ items: LeadItem[]; more: boolean }>;
	send(text: string, paths?: string[]): Promise<void>;
	/** Files on this Mac, sent to the box's Lead. */
	addPaths(paths: string[]): Promise<LeadAttachResult>;
	attachBytes(name: string, data: Uint8Array): Promise<LeadFile>;
	thumb(path: string): string | null;
	interrupt(): Promise<void>;
	reset(): Promise<void>;
	permission(id: string, answer: LeadPermissionAnswer): Promise<void>;
	setAuto(on: boolean): Promise<void>;
	proposal(id: string, outcome: "created" | "dismissed", taskId?: string): Promise<void>;
	reply(taskId: string, text: string): Promise<void>;
	react(id: string, emoji: string): Promise<void>;
	answer(input: {
		taskId: string;
		questionId: string;
		answer: string | string[] | null;
	}): Promise<void>;
	/** The box came or went: follow its connection now. */
	relink(): void;
	dispose(): void;
}

export function remoteLead(deps: RemoteLeadDeps): RemoteLead {
	const { box } = deps;
	let bound: { rpc: RpcClient; version: number; client: LeadClient; off: () => void } | null = null;
	// The conversation as last seen, kept current by the events: shown while the
	// box isn't held, so the chat stays readable.
	let last: LeadSnapshot = EMPTY;
	let disposed = false;
	prunePreviews(deps.previewDir);

	const relink = () => {
		if (disposed) return;
		const link = deps.link();
		if (bound && bound.rpc !== link?.rpc) {
			bound.off();
			bound = null;
		}
		if (!link || bound) return;
		const client = leadClient(link.rpc);
		const off = client.onEvent((e) => {
			last = applyLeadEvent(last, e);
			deps.emit(e);
		});
		const mine = { rpc: link.rpc, version: link.version, client, off };
		bound = mine;
		// This read is the Lead call that starts its events on this connection.
		void client.snapshot({ tail: REMOTE_TAIL }).then(
			(s) => {
				if (bound !== mine) return;
				last = s;
				deps.emit({ type: "reset", snapshot: s });
			},
			() => {},
		);
	};

	/** The box's Lead, connecting the box first when it isn't held. */
	const live = async (): Promise<LeadClient> => {
		relink();
		if (!bound) {
			await deps.connect();
			relink();
		}
		if (!bound) throw new Error(`${box} isn't connected.`);
		return bound.client;
	};

	const previewFile = (boxPath: string) =>
		join(deps.previewDir, `${createHash("sha256").update(`${box}\n${boxPath}`).digest("hex")}.txt`);
	const keepPreview = async (file: LeadFile, source: { path: string } | { bytes: Uint8Array }) => {
		if (!file.image) return;
		try {
			const url = await deps.preview(source);
			if (!url) return;
			mkdirSync(deps.previewDir, { recursive: true });
			writeFileSync(previewFile(file.path), url);
		} catch {
			// A missing preview is a chip instead of a thumbnail, nothing more.
		}
	};
	const tooBig = (name: string) => `${name} is over 10 MB, too big to send to ${box}'s Lead.`;

	const sendBytes = async (name: string, data: Uint8Array): Promise<LeadFile> => {
		if (data.byteLength > MAX_REMOTE_ATTACH_BYTES) throw new Error(tooBig(name));
		const client = await live();
		return client.attachBytes(name, Buffer.from(data).toString("base64"));
	};

	return {
		box,
		connected: () => {
			relink();
			return bound !== null;
		},
		canReact: () => bound !== null && boxSupports("leadReact", bound.version),
		async snapshot(tail) {
			relink();
			if (!bound) return last;
			const s = await bound.client.snapshot(tail !== undefined ? { tail } : undefined);
			last = s;
			return s;
		},
		async older(beforeId, limit) {
			return (await live()).older(beforeId, limit);
		},
		async send(text, paths) {
			await (await live()).send(text, paths ?? []);
		},
		async addPaths(paths) {
			const result: LeadAttachResult = { files: [], failed: [] };
			for (const path of paths) {
				const name = basename(path);
				try {
					if (!existsSync(path) || !statSync(path).isFile()) {
						result.failed.push(`${name} isn't a file.`);
						continue;
					}
					if (statSync(path).size > MAX_REMOTE_ATTACH_BYTES) {
						result.failed.push(tooBig(name));
						continue;
					}
					const file = await sendBytes(name, new Uint8Array(readFileSync(path)));
					await keepPreview(file, { path });
					result.files.push(file);
				} catch (e) {
					result.failed.push(e instanceof Error ? e.message : String(e));
				}
			}
			return result;
		},
		async attachBytes(name, data) {
			const file = await sendBytes(name, data);
			await keepPreview(file, { bytes: data });
			return file;
		},
		thumb(path) {
			try {
				const at = previewFile(path);
				return existsSync(at) ? readFileSync(at, "utf8") : null;
			} catch {
				return null;
			}
		},
		async interrupt() {
			await (await live()).interrupt();
		},
		async reset() {
			await (await live()).reset();
		},
		async permission(id, answer) {
			await (await live()).permission(id, answer);
		},
		async setAuto(on) {
			await (await live()).setAuto(on);
		},
		async proposal(id, outcome, taskId) {
			const client = await live();
			if (outcome === "created") await client.proposalCreated(id, taskId);
			else await client.dismissProposal(id);
		},
		async reply(taskId, text) {
			await (await live()).reply(taskId, text);
		},
		async react(id, emoji) {
			const client = await live();
			if (!bound || !boxSupports("leadReact", bound.version))
				throw new Error(`Update ${box} to answer with an emoji there.`);
			await client.react(id, emoji);
		},
		async answer(input) {
			await (await live()).answer(input);
		},
		relink,
		dispose() {
			disposed = true;
			bound?.off();
			bound = null;
		},
	};
}
