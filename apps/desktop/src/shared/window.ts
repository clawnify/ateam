// Native window state belongs to this desktop window, not a connected engine.
export const WINDOW_CH = {
	fullScreen: "window:fullScreen",
	evtFullScreen: "evt:window:fullScreen",
} as const;

export interface AteamWindow {
	/** Read synchronously so a reload in full screen starts in the right layout. */
	isFullScreen(): boolean;
	onFullScreen(cb: (fullScreen: boolean) => void): () => void;
}
