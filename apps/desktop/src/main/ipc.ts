import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { type AttachDelivery, CH, type OpenInEditorResult } from "@ateam/protocol";
import { endpointUrl } from "@ateam/server";
import { clipboard, dialog, ipcMain, nativeImage } from "electron";
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

/**
 * The editors we can hand a folder to, in preference order. First one found wins,
 * searched by editor rather than by PATH order so the choice is deterministic when
 * a machine has several.
 *
 * shortcut: a fixed list, no preference setting. Add one if users ask for a
 * different default than "whichever comes first here".
 */
const EDITORS = ["code", "cursor", "windsurf", "codium"] as const;

/**
 * Launched from Finder (rather than a shell) an Electron app inherits a bare PATH
 * — no /usr/local/bin, no /opt/homebrew/bin — so a PATH-only lookup finds nothing
 * in the packaged app even when the editor is plainly installed. Search the usual
 * install dirs too.
 */
const EDITOR_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

/** Absolute path of the first installed editor, or null if none is on this Mac. */
function findEditor(): string | null {
	const dirs = [...(process.env.PATH?.split(":") ?? []), ...EDITOR_DIRS];
	for (const cmd of EDITORS) {
		for (const dir of dirs) {
			if (!dir) continue;
			const full = join(dir, cmd);
			try {
				accessSync(full, constants.X_OK);
				return full;
			} catch {
				/* not here — keep looking */
			}
		}
	}
	return null;
}

// Channels the renderer calls with `ipcRenderer.send` (fire-and-forget) rather
// than `invoke` — they take no reply, so they bridge to ipcMain.on.
const SEND_CHANNELS = new Set<string>([CH.ptyWrite, CH.ptyResize]);

/** Desktop-native handlers that manage the OS, not the engine (windows, dialogs). */
export interface NativeHandlers {
	/** Detach a project into its own window (or focus its existing one). */
	openProjectWindow: (projectId: string) => void;
	/** Resolve the in-app editor URL for a task (starts it on the owning engine).
	 *  Client-native because reaching the port is transport knowledge (host.ts). */
	editorUrl: (taskId: string) => Promise<{ url: string }>;
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
			// `createDirectory` (macOS) shows the panel's "New Folder" button, so a brand-new
			// project folder can be made right here; App.tsx then offers to `git init` it.
			properties: ["openDirectory", "createDirectory"],
			title: "Select or create a project folder",
		});
		return res.canceled ? null : (res.filePaths[0] ?? null);
	});

	// Detach a project into its own OS window. Not an engine method — it drives
	// BrowserWindows, which only the desktop host has.
	ipcMain.handle(CH.editorOpenUrl, (_e, taskId: string) => native.editorUrl(taskId));

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

	// Deliver local image files to the terminal's agent, wherever it runs. The
	// aggregate knows which engine owns each terminal, so this is where the local
	// clipboard trick and the remote byte-push fork:
	//   - agent on a box → the Mac's clipboard and files are invisible to it, so
	//     ship each file's bytes over the engine RPC (util:writeImageBytes writes
	//     a temp file box-side) and return those paths for the renderer to TYPE —
	//     the same flow the iOS app proved against remote boxes.
	//   - local agent, one image → stage a real bitmap on the clipboard for a
	//     following Ctrl+V (pixels, not a path or a Finder file-icon).
	//   - local agent, several images (or an undecodable one) → the clipboard
	//     holds only one bitmap, so hand back the paths to type instead.
	async function deliverImages(terminalId: string, paths: string[]): Promise<AttachDelivery> {
		if (paths.length === 0) return { mode: "none" };
		if (router.ownerKind(terminalId) === "remote") {
			const remote: string[] = [];
			for (const p of paths) {
				try {
					const base64 = readFileSync(p).toString("base64");
					const ext = extname(p).slice(1);
					const method = CH.utilWriteImageBytes;
					remote.push((await router.handleFor(terminalId, method, [base64, ext])) as string);
				} catch {
					/* unreadable file or dropped wire — attach the ones that made it */
				}
			}
			return remote.length ? { mode: "paths", paths: remote } : { mode: "none" };
		}
		const [only] = paths;
		if (paths.length === 1 && only && stageImageOnClipboard(only)) return { mode: "ctrlv" };
		return { mode: "paths", paths };
	}

	// Attach image files: explicit `paths` from a renderer drop/paste, or null for
	// the "+ → Attach images" picker (multi-select, so several attach in one go).
	//
	// Always a picker when null — deliberately never sourced from the clipboard.
	// Staging writes the image *to* the clipboard, so reading it back here would
	// skip the picker on the next attach and re-stage the same image (you could
	// never add a second, different one). Copied screenshots/images are attached
	// via ⌘V paste, handled separately in the renderer's paste handler.
	ipcMain.handle(CH.utilAttachImages, async (_e, terminalId: string, paths: string[] | null) => {
		let files = paths;
		if (!files) {
			const res = await dialog.showOpenDialog({
				properties: ["openFile", "multiSelections"],
				title: "Attach images",
				filters: [
					{
						name: "Images",
						extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "heic", "avif"],
					},
				],
			});
			files = res.canceled ? [] : res.filePaths;
		}
		return deliverImages(terminalId, files);
	});

	// ⌘V of a raw bitmap (copied screenshot — no backing file). A local agent
	// reads the Mac clipboard itself off a bare Ctrl+V; a box agent can't, so
	// encode the clipboard image to PNG and push it like any other attachment.
	ipcMain.handle(CH.utilAttachClipboardImage, async (_e, terminalId: string) => {
		if (router.ownerKind(terminalId) !== "remote")
			return { mode: "ctrlv" } satisfies AttachDelivery;
		const img = clipboard.readImage();
		if (img.isEmpty()) return { mode: "none" } satisfies AttachDelivery;
		const base64 = img.toPNG().toString("base64");
		const path = await router.handleFor(terminalId, CH.utilWriteImageBytes, [base64, "png"]);
		return { mode: "paths", paths: [path as string] } satisfies AttachDelivery;
	});

	// Hand a task's worktree to the user's own editor. Client-native on purpose: the
	// editor is a desktop app on THIS Mac, so this never routes to the engine. For a
	// task on a box, VS Code's Remote-SSH opens the box-side path over the same
	// ssh_config alias Ateam already connects with — the box needs no editor
	// installed, the client pushes a server there on first connect.
	ipcMain.handle(
		CH.utilOpenInEditor,
		async (_e, worktreePath: string, alias: string | null): Promise<OpenInEditorResult> => {
			const editor = findEditor();
			if (!editor)
				return { ok: false, reason: `No editor found (looked for ${EDITORS.join(", ")}).` };
			// A ws connection is a `host:port` endpoint, not an ssh_config alias, so
			// Remote-SSH has nothing to resolve. Failing loudly beats the alternative:
			// opening the path locally would silently show THIS Mac's copy of it.
			if (alias !== null && endpointUrl(alias))
				return {
					ok: false,
					reason: `"${alias}" is a direct endpoint, not an ssh_config alias. Remote-SSH needs an alias — add one to ~/.ssh/config and connect through it.`,
				};
			const args =
				alias === null ? [worktreePath] : ["--remote", `ssh-remote+${alias}`, worktreePath];
			// Detached: the editor outlives Ateam, and must not die with it.
			spawn(editor, args, { detached: true, stdio: "ignore" }).unref();
			return { ok: true };
		},
	);
}
