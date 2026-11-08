import type { McMetrics } from "@ateam/panes";

export const MC_NATIVE_FONT_SIZE = 12.5;

// SwiftTerm's monospaced system font, measured on the 2x iPad simulator:
// a 658×368pt terminal reports 82×24 cells; 658×324pt reports 82×21.
// AppleTerminalView.computeFontDimensions snaps width to device pixels and
// rounds line height up. 8pt is also a conservative width on 3x screens.
// Re-measure if the font or tile chrome changes.
export const MC_NATIVE_METRICS: McMetrics = {
	cellWidth: 8,
	cellHeight: 15,
	chromeWidth: 2, // two 1pt tile edges, no terminal padding
	// Two edges + 30pt TerminalStrip + 44pt session row. Reserve the row even
	// for single-session tiles so discovering another session cannot re-page.
	chromeHeight: 76,
};
