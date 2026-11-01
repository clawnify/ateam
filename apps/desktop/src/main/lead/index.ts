// The desktop's Lead chat: one coordinator conversation over every engine the
// desktop holds. The chat itself is @ateam/server's (packages/server/src/lead),
// which a box's engine also runs for the phone; this is the desktop's wiring of
// it: the aggregate router, files sent on to a box (deliver-files.ts), and the
// renderer's IPC, with the native file picker and image previews.
import { LEAD_CH, type LeadEvent, type LeadPermissionAnswer, type TaskDTO } from "@ateam/protocol";
import { startLead as startLeadCore } from "@ateam/server";
import { dialog, ipcMain, nativeImage } from "electron";
import type { Router } from "../backend";
import { deliverFiles } from "../deliver-files";

export interface LeadDeps {
	router: Router;
	/** The box an entity lives on, or null for this Mac (host.origins). */
	machineOf(id: string): string | null;
	/** userData/lead: transcript, session id, MCP config, followed tasks. */
	dir: string;
	broadcast(channel: string, e: LeadEvent): void;
}

export interface Lead {
	/** Feed every engine's taskUpdated here: followed tasks report back. */
	onTaskUpdated(task: TaskDTO): void;
	dispose(): void;
}

export async function startLead(deps: LeadDeps): Promise<Lead> {
	const lead = await startLeadCore({
		place: "mac",
		dir: deps.dir,
		handle: async (method, args) => deps.router.handle(method, args),
		machineOf: deps.machineOf,
		deliver: (ownerId, paths) => deliverFiles(deps.router, ownerId, paths),
		emit: (e) => deps.broadcast(LEAD_CH.evtEvent, e),
	});
	ipcMain.handle(LEAD_CH.snapshot, () => lead.snapshot());
	ipcMain.handle(LEAD_CH.send, (_e, text: string, paths?: string[]) => lead.send(text, paths));
	// Attach: paths dropped or pasted from Finder, or null for the picker.
	ipcMain.handle(LEAD_CH.attach, async (_e, paths: string[] | null) => {
		let list = paths;
		if (!list) {
			const res = await dialog.showOpenDialog({
				properties: ["openFile", "multiSelections"],
				title: "Attach files",
			});
			list = res.canceled ? [] : res.filePaths;
		}
		return lead.attachments.addPaths(list.map(String));
	});
	ipcMain.handle(LEAD_CH.attachBytes, (_e, name: string, data: Uint8Array) =>
		lead.attachBytes(String(name), data),
	);
	// A preview for an attached image. Only attachments: the renderer never names
	// a file on this Mac to be read.
	ipcMain.handle(LEAD_CH.thumb, async (_e, path: string) => {
		const files = lead.attachments.resolve([String(path)]);
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
	ipcMain.handle(LEAD_CH.interrupt, () => lead.interrupt());
	ipcMain.handle(LEAD_CH.reset, () => lead.reset());
	ipcMain.handle(LEAD_CH.permission, (_e, id: string, answer: LeadPermissionAnswer) =>
		lead.permission(String(id), answer),
	);
	ipcMain.handle(LEAD_CH.setAuto, (_e, on: boolean) => lead.setAuto(on === true));
	// The user created a proposal from its dialog, or dismissed it.
	ipcMain.handle(
		LEAD_CH.proposal,
		(_e, id: string, outcome: "created" | "dismissed", taskId?: string) =>
			lead.proposal(String(id), outcome, taskId),
	);
	ipcMain.handle(LEAD_CH.reply, (_e, taskId: string, text: string) => lead.reply(taskId, text));
	ipcMain.handle(
		LEAD_CH.answer,
		(_e, input: { taskId: string; questionId: string; answer: string | string[] | null }) =>
			lead.answer(input),
	);
	return {
		onTaskUpdated: (task) => lead.onTaskUpdated(task),
		dispose: () => lead.dispose(),
	};
}
