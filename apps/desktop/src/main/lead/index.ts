// The desktop's Lead chats: the main window's, one coordinator conversation
// over every engine the desktop holds, and one per project window, about that
// project (LeadToolDeps.home). The chat itself is @ateam/server's
// (packages/server/src/lead), which a box's engine also runs for the phone; this
// is the desktop's wiring of it: the aggregate router, files sent on to a box
// (deliver-files.ts), and the renderer's IPC, routed to the chat of the window
// that calls, with the native file picker and image previews.
//
// The main window's chat can live on a box instead (`client.leadBox`, set from
// Settings → Boxes): it is then that box's own Lead, the one the phone talks to
// (remote.ts), and this Mac's keeps running unseen, its followed tasks still
// reporting into it, until the chat moves back. Project windows always talk to
// this Mac's chats.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	LEAD_CH,
	type LeadAttachResult,
	type LeadCallTurn,
	type LeadFile,
	type LeadHome,
	type LeadItem,
	type LeadPermissionAnswer,
	type LeadSnapshot,
	type TaskDTO,
} from "@ateam/protocol";
import {
	type Lead as CoreLead,
	judgeCall,
	LEAD_IDLE_STOP_MS,
	nudgeFor,
	readSettings,
	startCall,
	startLead as startLeadCore,
	updateSettings,
} from "@ateam/server";
import {
	dialog,
	type IpcMainInvokeEvent,
	ipcMain,
	type NativeImage,
	nativeImage,
	type WebContents,
} from "electron";
import type { Router } from "../backend";
import { deliverFiles } from "../deliver-files";
import type { Host } from "../host";
import { type RemoteLead, remoteLead } from "./remote";

export interface LeadDeps {
	router: Router;
	/** The box an entity lives on, or null for this Mac (host.origins). */
	machineOf(id: string): string | null;
	/** userData/lead: the main chat's transcript, session id, MCP config and
	 *  followed tasks. A project's chat keeps its own in projects/<id> below it,
	 *  and works in this folder too, so "Always allow" rules hold in every chat. */
	dir: string;
	/** The project a window is pinned to, or null for the main window. */
	projectOf(sender: WebContents): string | null;
	/** Send to the windows showing this chat: a project's, or null for the main one. */
	sendTo(project: string | null, channel: string, payload: unknown): void;
	/** The boxes, for a main chat that lives on one. */
	boxes: Pick<Host, "boxLink" | "onBoxChange" | "connect">;
}

export interface Lead {
	/** Feed every engine's taskUpdated here: followed tasks report back. */
	onTaskUpdated(task: TaskDTO): void;
	dispose(): void;
}

/** What the IPC handlers ask of a chat, on this Mac or on a box. */
interface Chat {
	snapshot(tail?: number): LeadSnapshot | Promise<LeadSnapshot>;
	older(
		beforeId: string,
		limit: number,
	): { items: LeadItem[]; more: boolean } | Promise<{ items: LeadItem[]; more: boolean }>;
	send(text: string, paths?: string[]): void | Promise<void>;
	addPaths(paths: string[]): LeadAttachResult | Promise<LeadAttachResult>;
	attachBytes(name: string, data: Uint8Array): LeadFile | Promise<LeadFile>;
	thumb(path: string): string | null | Promise<string | null>;
	interrupt(): void | Promise<void>;
	reset(): void | Promise<void>;
	permission(id: string, answer: LeadPermissionAnswer): void | Promise<void>;
	setAuto(on: boolean): void | Promise<void>;
	setCall(on: boolean): void | Promise<void>;
	proposal(id: string, outcome: "created" | "dismissed", taskId?: string): Promise<void>;
	reply(taskId: string, text: string): Promise<void>;
	react(id: string, emoji: string): Promise<void>;
	answer(input: {
		taskId: string;
		questionId: string;
		answer: string | string[] | null;
	}): Promise<void>;
}

/** A project id as a folder name (they are UUIDs): nothing that leaves projects/. */
const FOLDER_ID = /^[\w-]+$/;

/** At most 240 px tall, keeping its shape. */
const small = (img: NativeImage) => {
	const { height } = img.getSize();
	return (height > 240 ? img.resize({ height: 240 }) : img).toDataURL();
};

/** A preview of an image file on this Mac. Decoded and scaled keeping its
 *  shape; Quick Look's thumbnail (createThumbnailFromPath) stretches to the box
 *  it is given, so it is only the fallback, for what nativeImage can't decode
 *  (HEIC). */
async function previewOf(source: { path: string } | { bytes: Uint8Array }): Promise<string | null> {
	try {
		const img =
			"path" in source
				? nativeImage.createFromPath(source.path)
				: nativeImage.createFromBuffer(Buffer.from(source.bytes));
		if (!img.isEmpty()) return small(img);
		if (!("path" in source)) return null;
		const ql = await nativeImage.createThumbnailFromPath(source.path, { width: 240, height: 240 });
		return ql.isEmpty() ? null : ql.toDataURL();
	} catch {
		return null;
	}
}

/** This Mac's chat, as the IPC handlers ask for it. */
function localChat(l: CoreLead): Chat {
	return {
		snapshot: (tail) => l.snapshot(tail),
		older: (beforeId, limit) => l.older(beforeId, limit),
		send: (text, paths) => l.send(text, paths),
		addPaths: (paths) => l.attachments.addPaths(paths),
		attachBytes: (name, data) => l.attachBytes(name, data),
		// Only attachments: the renderer never names a file on this Mac to be read.
		thumb: async (path) => {
			const files = l.attachments.resolve([path]);
			if (typeof files === "string" || !files[0]?.image) return null;
			return previewOf({ path: files[0].path });
		},
		interrupt: () => l.interrupt(),
		reset: () => l.reset(),
		permission: (id, answer) => l.permission(id, answer),
		setAuto: (on) => l.setAuto(on),
		setCall: (on) => l.setCall(on),
		proposal: (id, outcome, taskId) => l.proposal(id, outcome, taskId),
		reply: (taskId, text) => l.reply(taskId, text),
		react: (id, emoji) => l.react(id, emoji),
		answer: (input) => l.answer(input),
	};
}

export async function startLead(deps: LeadDeps): Promise<Lead> {
	const projectsDir = join(deps.dir, "projects");
	// Every chat by project ("" = the main one), started once and kept until
	// quit: a project chat's followed tasks keep reporting back with its window
	// closed, and its agent stops itself when idle.
	const starting = new Map<string, Promise<CoreLead>>();
	const ready = new Map<string, CoreLead>();
	const chat = (project: string | null): Promise<CoreLead> => {
		const key = project ?? "";
		if (project && !FOLDER_ID.test(project))
			return Promise.reject(new Error(`No Lead chat for project ${JSON.stringify(project)}.`));
		let p = starting.get(key);
		if (!p) {
			p = startLeadCore({
				place: "mac",
				dir: project ? join(projectsDir, project) : deps.dir,
				handle: async (method, args) => deps.router.handle(method, args),
				machineOf: deps.machineOf,
				deliver: (ownerId, paths) => deliverFiles(deps.router, ownerId, paths),
				// The main chat's events reach the main window only while it shows them.
				emit: (e) => {
					if (project || !remote) deps.sendTo(project, LEAD_CH.evtEvent, e);
				},
				...(project
					? {
							cwd: deps.dir,
							home: project,
							idleStopMs: LEAD_IDLE_STOP_MS,
							onElsewhere: (line: string) => ready.get("")?.note(line),
						}
					: {}),
			});
			starting.set(key, p);
			p.then(
				(l) => ready.set(key, l),
				// Let the next call try again rather than fail forever.
				() => starting.delete(key),
			);
		}
		return p;
	};

	// The main window's chat on a box, while `client.leadBox` names one.
	let remote: RemoteLead | null = null;
	const homeOf = (): LeadHome =>
		remote
			? {
					box: remote.box,
					connected: remote.connected(),
					canReact: remote.canReact(),
					canCall: remote.canCall(),
				}
			: { box: null, connected: true, canReact: true, canCall: true };
	const tellHome = () => deps.sendTo(null, LEAD_CH.evtHome, homeOf());
	const moveTo = (box: string | null) => {
		remote?.dispose();
		remote = null;
		if (box) {
			remote = remoteLead({
				box,
				link: () => deps.boxes.boxLink(box),
				connect: async () => void (await deps.boxes.connect(box, false, { wake: true })),
				emit: (e) => deps.sendTo(null, LEAD_CH.evtEvent, e),
				preview: previewOf,
				previewDir: join(deps.dir, "box-previews"),
			});
			remote.relink();
		}
		tellHome();
	};
	const offBoxes = deps.boxes.onBoxChange((alias, change) => {
		if (remote?.box !== alias) return;
		if (change === "forgotten") {
			// Gone from the list: the chat comes back to this Mac.
			updateSettings({ client: { leadBox: null } });
			moveTo(null);
			return;
		}
		remote.relink();
		tellHome();
	});

	const main = await chat(null);
	moveTo(readSettings().settings.client.leadBox ?? null);
	// Chats from earlier runs, so their followed tasks report back before their
	// window is opened again.
	if (existsSync(projectsDir))
		for (const id of readdirSync(projectsDir))
			if (FOLDER_ID.test(id))
				chat(id).catch((err) => console.error(`[ateam] Lead chat for ${id} failed:`, err));
	/** The chat of the window that called. */
	const lead = async (e: IpcMainInvokeEvent): Promise<Chat> => {
		const project = deps.projectOf(e.sender);
		if (project) return localChat(await chat(project));
		return remote ?? localChat(main);
	};

	ipcMain.handle(LEAD_CH.snapshot, async (e, opts?: { tail?: unknown }) => {
		const tail = opts?.tail;
		return (await lead(e)).snapshot(typeof tail === "number" && tail >= 0 ? tail : undefined);
	});
	ipcMain.handle(LEAD_CH.older, async (e, beforeId: string, limit: number) =>
		(await lead(e)).older(
			String(beforeId),
			typeof limit === "number" && limit > 0 ? Math.min(limit, 500) : 100,
		),
	);
	ipcMain.handle(LEAD_CH.send, async (e, text: string, paths?: string[]) =>
		(await lead(e)).send(text, paths),
	);
	// Attach: paths dropped or pasted from Finder, or null for the picker.
	ipcMain.handle(LEAD_CH.attach, async (e, paths: string[] | null) => {
		let list = paths;
		if (!list) {
			const res = await dialog.showOpenDialog({
				properties: ["openFile", "multiSelections"],
				title: "Attach files",
			});
			list = res.canceled ? [] : res.filePaths;
		}
		return (await lead(e)).addPaths(list.map(String));
	});
	ipcMain.handle(LEAD_CH.attachBytes, async (e, name: string, data: Uint8Array) =>
		(await lead(e)).attachBytes(String(name), data),
	);
	// A preview for an attached image, as a data: URL (the window's CSP allows no files).
	ipcMain.handle(LEAD_CH.thumb, async (e, path: string) => (await lead(e)).thumb(String(path)));
	ipcMain.handle(LEAD_CH.interrupt, async (e) => (await lead(e)).interrupt());
	ipcMain.handle(LEAD_CH.reset, async (e) => (await lead(e)).reset());
	ipcMain.handle(LEAD_CH.permission, async (e, id: string, answer: LeadPermissionAnswer) =>
		(await lead(e)).permission(String(id), answer),
	);
	ipcMain.handle(LEAD_CH.setAuto, async (e, on: boolean) => (await lead(e)).setAuto(on === true));
	ipcMain.handle(LEAD_CH.callActive, async (e, on: boolean) =>
		(await lead(e)).setCall(on === true),
	);
	// The user created a proposal from its dialog, or dismissed it.
	ipcMain.handle(
		LEAD_CH.proposal,
		async (e, id: string, outcome: "created" | "dismissed", taskId?: string) =>
			(await lead(e)).proposal(String(id), outcome, taskId),
	);
	ipcMain.handle(LEAD_CH.reply, async (e, taskId: string, text: string) =>
		(await lead(e)).reply(taskId, text),
	);
	ipcMain.handle(LEAD_CH.react, async (e, id: string, emoji: string) =>
		(await lead(e)).react(String(id), String(emoji)),
	);
	ipcMain.handle(
		LEAD_CH.answer,
		async (e, input: { taskId: string; questionId: string; answer: string | string[] | null }) =>
			(await lead(e)).answer(input),
	);
	// A voice call runs in the window; only its session is opened here, from
	// this Mac's OpenAI key, whichever machine the chat itself lives on.
	ipcMain.handle(LEAD_CH.callStart, (_e, sdp: string, input: LeadCallTurn[]) =>
		startCall(String(sdp), input),
	);
	ipcMain.handle(LEAD_CH.callJudge, (_e, pieces: unknown, context: unknown, opts: unknown) =>
		judgeCall(pieces, context, opts),
	);
	ipcMain.handle(LEAD_CH.callNudge, (_e, task: unknown, reply: unknown) => nudgeFor(task, reply));
	ipcMain.handle(
		LEAD_CH.home,
		(e): LeadHome =>
			deps.projectOf(e.sender)
				? { box: null, connected: true, canReact: true, canCall: true }
				: homeOf(),
	);
	// Settings → Boxes moves the main chat. Only to a box that is held now, so
	// its engine's version says it has a Lead at all.
	ipcMain.handle(LEAD_CH.setHome, (_e, box: string | null): LeadHome => {
		const next = typeof box === "string" && box ? box : null;
		if (next) {
			const link = deps.boxes.boxLink(next);
			if (!link) throw new Error(`Connect ${next} first.`);
			if (link.version < 24) throw new Error(`Update ${next} first: its engine has no Lead.`);
		}
		if (next !== (remote?.box ?? null)) {
			updateSettings({ client: { leadBox: next } });
			moveTo(next);
		}
		return homeOf();
	});
	return {
		onTaskUpdated: (task) => {
			for (const l of ready.values()) l.onTaskUpdated(task);
		},
		dispose: () => {
			offBoxes();
			remote?.dispose();
			for (const l of ready.values()) l.dispose();
		},
	};
}
