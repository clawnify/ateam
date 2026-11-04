// Installer output shown as plain text (a box's set-up log): the colour and cursor codes
// a terminal would act on are noise there. OpenCode's installer, for one, dims its tips
// with `ESC[0;2m`, which a <pre> printed as "[0;2m".

// CSI sequences (colours, cursor moves) and OSC ones (titles, links), then any ESC left.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape codes is the point
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b/g;

export function stripAnsi(text: string): string {
	return text.replace(ESCAPES, "");
}
