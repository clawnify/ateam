import { clipboard, dialog, ipcMain, nativeImage } from "electron";
import { CH } from "@ateam/protocol";
import type { Router } from "./backend";

/**
 * Load an image file and put it on the clipboard as a real bitmap, so a
 * following Ctrl+V hands the agent pixels — not a path, and not the generic
 * file-type icon a raw clipboard read of a Finder file copy returns. Returns
 * false when the path is missing or isn't a decodable image.
 */
function stageImageOnClipboard(path: string | null): boolean {
	if (!path) return false;
	const img = nativeImage.createFromPath(path);
	if (img.isEmpty()) return false;
	clipboard.writeImage(img);
	return true;
}

// Channels the renderer calls with `ipcRenderer.send` (fire-and-forget) rather
// than `invoke` — they take no reply, so they bridge to ipcMain.on.
const SEND_CHANNELS = new Set<string>([CH.ptyWrite, CH.ptyResize]);

/** Desktop-native handlers that manage the OS, not the engine (windows, dialogs). */
export interface NativeHandlers {
	/** Detach a project into its own window (or focus its existing one). */
	openProjectWindow: (projectId: string) => void;
}

/**
 * Bridge Electron IPC to the active engine backend. Every engine method flows
 * through `router.handle` — which routes to whichever backend (local in-process,
 * or a remote host over SSH) is currently active, so channels are registered once
 * and never re-bound on a connection swap. Only the handful of handlers that touch
 * the desktop OS itself (native dialog/clipboard, window management) live here.
 */
export function registerIpc(router: Router, native: NativeHandlers): void {
	for (const method of router.methods) {
		if (SEND_CHANNELS.has(method)) {
			ipcMain.on(method, (_e, ...args: unknown[]) => void router.handle(method, args));
		} else {
			ipcMain.handle(method, (_e, ...args: unknown[]) => router.handle(method, args));
		}
	}

	// ---- client-native handlers (need the desktop OS, not the engine) ----
	ipcMain.handle(CH.projectsPick, async () => {
		const res = await dialog.showOpenDialog({
			properties: ["openDirectory"],
			title: "Select a git repository",
		});
		return res.canceled ? null : (res.filePaths[0] ?? null);
	});

	// Detach a project into its own OS window. Not an engine method — it drives
	// BrowserWindows, which only the desktop host has.
	ipcMain.handle(CH.windowOpenProject, async (_e, projectId: string) => {
		native.openProjectWindow(projectId);
	});

	// Native file picker for the terminal toolbar's "+ → Files…" action; the
	// renderer types the chosen paths into the PTY like a drag-and-drop would.
	ipcMain.handle(CH.utilPickFiles, async () => {
		const res = await dialog.showOpenDialog({
			properties: ["openFile", "multiSelections"],
			title: "Add files to terminal",
		});
		return res.canceled ? [] : res.filePaths;
	});

	// "+ → Attach image": open a picker, then stage the chosen image as a real
	// bitmap on the clipboard so the renderer's following Ctrl+V hands the agent
	// pixels, not a path or a file-icon.
	//
	// Always a picker — deliberately never sourced from the clipboard. Staging
	// writes the image *to* the clipboard, so reading it back here would skip the
	// picker on the next attach and re-stage the same image (you could never add a
	// second, different one). Copied screenshots/images are attached via ⌘V paste,
	// handled separately in the renderer's paste handler.
	ipcMain.handle(CH.utilStageImage, async () => {
		const res = await dialog.showOpenDialog({
			properties: ["openFile"],
			title: "Attach image",
			filters: [
				{
					name: "Images",
					extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "heic", "avif"],
				},
			],
		});
		return stageImageOnClipboard(res.canceled ? null : (res.filePaths[0] ?? null));
	});

	// Paste/drop of a copied image *file*: stage its bytes as a real bitmap so the
	// renderer's following Ctrl+V attaches the pixels. Returns false (renderer
	// then falls back to typing the path) if the file isn't a decodable image.
	ipcMain.handle(CH.utilStageImagePath, async (_e, path: string) => stageImageOnClipboard(path));
}
