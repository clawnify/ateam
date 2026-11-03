// The theme's main-process half (shared/theme.ts says why it is not a plain
// settings row): the file on this Mac is the only source, and a change
// repaints every open window, the window behind the page included.

import { readFileSync } from "node:fs";
import type { ThemeId } from "@ateam/protocol";
import { readSettings, settingsPath, updateSettings } from "@ateam/server";
import { BrowserWindow, ipcMain } from "electron";
import { isThemeId, THEME_CH, themeOrDefault, windowBackground } from "../shared/theme";

export function savedTheme(): ThemeId {
	return themeOrDefault(readSettings().settings.client.theme);
}

/** A theme the file itself names, as opposed to the default filled in for a missing key. */
function themeSaved(): boolean {
	try {
		const raw = JSON.parse(readFileSync(settingsPath(), "utf8")) as {
			client?: { theme?: unknown };
		};
		return isThemeId(raw?.client?.theme);
	} catch {
		return false; // no file yet, or one readSettings will report
	}
}

/** `isEmpty`: no project anywhere and no box ever connected (main/index.ts asks the host). */
export function registerThemeIpc(isEmpty: () => Promise<boolean>): void {
	ipcMain.handle(
		THEME_CH.firstRun,
		async () => !themeSaved() && (await isEmpty().catch(() => false)),
	);
	ipcMain.on(THEME_CH.get, (e) => {
		e.returnValue = savedTheme();
	});
	ipcMain.handle(THEME_CH.set, (_e, id: unknown) => {
		if (!isThemeId(id)) throw new Error(`Unknown theme: ${String(id)}`);
		updateSettings({ client: { theme: id } });
		for (const win of BrowserWindow.getAllWindows()) {
			if (win.isDestroyed()) continue;
			win.setBackgroundColor(windowBackground(id));
			win.webContents.send(THEME_CH.evtChanged, id);
		}
	});
}
