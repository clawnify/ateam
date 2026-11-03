// The theme's main-process half (shared/theme.ts says why it is not a plain
// settings row): the file on this Mac is the only source, and a change
// repaints every open window, the window behind the page included.
import type { ThemeId } from "@ateam/protocol";
import { readSettings, updateSettings } from "@ateam/server";
import { BrowserWindow, ipcMain } from "electron";
import { isThemeId, THEME_CH, themeOrDefault, windowBackground } from "../shared/theme";

export function savedTheme(): ThemeId {
	return themeOrDefault(readSettings().settings.client.theme);
}

export function registerThemeIpc(): void {
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
