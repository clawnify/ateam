// The desktop's theme: which palette the renderer's CSS tokens take (index.css,
// `:root[data-theme=…]`) and the window's own background behind them.
//
// It lives in `client.theme` of ~/.ateam/settings.json, but is read and written
// here, in main, rather than through window.ateam.settings: with "Sync settings
// to boxes" off that surface follows the selected box, and a theme is this
// Mac's. Main also has to know it before a window exists (its background) and
// the renderer before its first paint, so the preload asks for it synchronously.
import type { ThemeId } from "@ateam/protocol";

export const THEME_CH = {
	/** Synchronous (ipcRenderer.sendSync): the saved theme, read at preload time. */
	get: "theme:get",
	set: "theme:set",
	firstRun: "theme:firstRun",
	evtChanged: "evt:theme:changed",
} as const;

export const DEFAULT_THEME: ThemeId = "dark";

export const THEMES: { id: ThemeId; label: string; windowBackground: string }[] = [
	{ id: "dark", label: "Dark", windowBackground: "#141414" },
	{ id: "light", label: "Light", windowBackground: "#f3f3f3" },
	// Ateam's first palette: near-black with a cool tint.
	{ id: "classic", label: "Classic", windowBackground: "#0c0c0e" },
];

export function isThemeId(v: unknown): v is ThemeId {
	return THEMES.some((t) => t.id === v);
}

/** A hand-edited value nothing knows falls back to the default. */
export function themeOrDefault(v: unknown): ThemeId {
	return isThemeId(v) ? v : DEFAULT_THEME;
}

export function windowBackground(id: ThemeId): string {
	return THEMES.find((t) => t.id === id)?.windowBackground ?? "#141414";
}

export interface AteamTheme {
	/** The saved theme, as this window opens. */
	saved(): ThemeId;
	/** Save it and repaint every window in it. */
	set(id: ThemeId): Promise<void>;
	/**
	 * Open on the theme choice instead of the board: a new install (no
	 * project, no box ever connected) that hasn't saved a theme yet. Someone
	 * updating from an older version has projects, so they never see it.
	 */
	firstRun(): Promise<boolean>;
	/** Another window (or this one) changed it. */
	onChange(cb: (id: ThemeId) => void): () => void;
}
