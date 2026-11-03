// The theme in this window: `data-theme` on <html> picks the token set in
// index.css, and xterm (which paints on a canvas, out of CSS's reach) takes
// its palette from terminalTheme(). shared/theme.ts holds the list and why the
// value lives in main.
import type { ThemeId } from "@ateam/protocol";
import type { ITheme } from "@xterm/xterm";
import { useSyncExternalStore } from "react";
import { themeOrDefault } from "../../../shared/theme";

const EVENT = "ateam:theme";

export function activeTheme(): ThemeId {
	return themeOrDefault(document.documentElement.dataset.theme);
}

export function applyTheme(id: ThemeId): void {
	if (document.documentElement.dataset.theme === id) return;
	document.documentElement.dataset.theme = id;
	window.dispatchEvent(new Event(EVENT));
}

/** Runs `cb` after every change of theme in this window. */
export function onThemeChange(cb: () => void): () => void {
	window.addEventListener(EVENT, cb);
	return () => window.removeEventListener(EVENT, cb);
}

export function useTheme(): ThemeId {
	return useSyncExternalStore(onThemeChange, activeTheme);
}

// Blue, cyan and magenta in Dark are Nord's (nord9, nord8, nord15; MIT,
// github.com/nordtheme/nord). Classic keeps xterm's own ANSI colours.
const TERMINAL: Record<ThemeId, ITheme> = {
	dark: {
		background: "#141414",
		foreground: "#f0f0f0",
		cursor: "#f0f0f0",
		cursorAccent: "#141414",
		selectionBackground: "#f0f0f01e",
		black: "#242424",
		red: "#fc6b83",
		green: "#3fa266",
		yellow: "#d2943e",
		blue: "#81a1c1",
		magenta: "#b48ead",
		cyan: "#88c0d0",
		white: "#f0f0f0",
		brightBlack: "#989898",
		brightRed: "#fc6b83",
		brightGreen: "#70b489",
		brightYellow: "#f1b467",
		brightBlue: "#87a6c4",
		brightMagenta: "#b48ead",
		brightCyan: "#88c0d0",
		brightWhite: "#ffffff",
	},
	light: {
		background: "#f3f3f3",
		foreground: "#141414",
		cursor: "#141414",
		cursorAccent: "#f3f3f3",
		selectionBackground: "#14141424",
		black: "#141414",
		red: "#be1744",
		green: "#007041",
		yellow: "#8b5700",
		blue: "#0064b0",
		magenta: "#92156a",
		cyan: "#176c74",
		white: "#fcfcfc",
		brightBlack: "#4e4e4e",
		brightRed: "#ce405b",
		brightGreen: "#00854c",
		brightYellow: "#a46700",
		brightBlue: "#2778c1",
		brightMagenta: "#b54e90",
		brightCyan: "#3b7e84",
		brightWhite: "#ffffff",
	},
	classic: { background: "#000000", foreground: "#e6e6ea" },
};

export function terminalTheme(id: ThemeId = activeTheme()): ITheme {
	return TERMINAL[id];
}
