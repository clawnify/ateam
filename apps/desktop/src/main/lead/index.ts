// The desktop's Lead chats: the main window's, one coordinator conversation
// over every engine the desktop holds, and one per project window, about that
// project (LeadToolDeps.home). The chat itself is @ateam/server's
// (packages/server/src/lead), which a box's engine also runs for the phone; this
// is the desktop's wiring of it: the aggregate router, files sent on to a box
// (deliver-files.ts), and the renderer's IPC, routed to the chat of the window
// that calls, with the native file picker and image previews.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LEAD_CH, type LeadEvent, type LeadPermissionAnswer, type TaskDTO } from "@ateam/protocol";
import {
	type Lead as CoreLead,
	LEAD_IDLE_STOP_MS,
	startLead as startLeadCore,
} from "@ateam/server";
import { dialog, type IpcMainInvokeEvent, ipcMain, nativeImage, type WebContents } from "electron";
import type { Router } from "../backend";
import { deliverFiles } from "../deliver-files";

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
	sendTo(project: string | null, channel: string, e: LeadEvent): void;
}

export interface Lead {
	/** Feed every engine's taskUpdated here: followed tasks report back. */
	onTaskUpdated(task: TaskDTO): void;
	dispose(): void;
}

/** A project id as a folder name (they are UUIDs): nothing that leaves projects/. */
const FOLDER_ID = /^[\w-]+$/;

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
				emit: (e) => deps.sendTo(project, LEAD_CH.evtEvent, e),
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
	const main = await chat(null);
	// Chats from earlier runs, so their followed tasks report back before their
	// window is opened again.
	if (existsSync(projectsDir))
		for (const id of readdirSync(projectsDir))
			if (FOLDER_ID.test(id))
				chat(id).catch((err) => console.error(`[ateam] Lead chat for ${id} failed:`, err));
	/** The chat of the window that called. */
	const lead = (e: IpcMainInvokeEvent) => {
		const project = deps.projectOf(e.sender);
		return project ? chat(project) : Promise.resolve(main);
	};

	ipcMain.handle(LEAD_CH.snapshot, async (e) => (await lead(e)).snapshot());
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
		return (await lead(e)).attachments.addPaths(list.map(String));
	});
	ipcMain.handle(LEAD_CH.attachBytes, async (e, name: string, data: Uint8Array) =>
		(await lead(e)).attachBytes(String(name), data),
	);
	// A preview for an attached image. Only attachments: the renderer never names
	// a file on this Mac to be read.
	ipcMain.handle(LEAD_CH.thumb, async (e, path: string) => {
		const files = (await lead(e)).attachments.resolve([String(path)]);
		if (typeof files === "string" || !files[0]?.image) return null;
		try {
			// Decoded and scaled keeping its shape. Quick Look's thumbnail
			// (createThumbnailFromPath) stretches to the box it is given, so it is
			// only the fallback, for what nativeImage can't decode (HEIC).
			const img = nativeImage.createFromPath(files[0].path);
			if (!img.isEmpty()) {
				const { height } = img.getSize();
				return (height > 240 ? img.resize({ height: 240 }) : img).toDataURL();
			}
			const ql = await nativeImage.createThumbnailFromPath(files[0].path, {
				width: 240,
				height: 240,
			});
			return ql.isEmpty() ? null : ql.toDataURL();
		} catch {
			return null;
		}
	});
	ipcMain.handle(LEAD_CH.interrupt, async (e) => (await lead(e)).interrupt());
	ipcMain.handle(LEAD_CH.reset, async (e) => (await lead(e)).reset());
	ipcMain.handle(LEAD_CH.permission, async (e, id: string, answer: LeadPermissionAnswer) =>
		(await lead(e)).permission(String(id), answer),
	);
	ipcMain.handle(LEAD_CH.setAuto, async (e, on: boolean) => (await lead(e)).setAuto(on === true));
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
	return {
		onTaskUpdated: (task) => {
			for (const l of ready.values()) l.onTaskUpdated(task);
		},
		dispose: () => {
			for (const l of ready.values()) l.dispose();
		},
	};
}
