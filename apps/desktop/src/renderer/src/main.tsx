import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Welcome } from "./components/Welcome";
import "./globals.css";
import { applyTheme } from "./lib/theme";

// Before the first render, so the window never paints in the wrong colours.
applyTheme(window.ateamTheme.saved());
window.ateamTheme.onChange(applyTheme);

// Global drop guard. The terminal handles drops on its own element (typing the
// dropped file's path to the PTY), but a file dropped ANYWHERE else in the
// window — sidebar, header, gaps between Mission Control tiles — would hit
// Chromium's default and navigate the window to file://…/image.png, i.e. it
// "opens the image in a new window". Preventing the default at the window level
// makes a stray drop a no-op. The terminal's own listeners sit closer to the
// drop target, so they still run first and do their job; this only catches the
// misses.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// Note: intentionally NOT wrapped in <StrictMode>. Its dev-only double
// mount/unmount disposes and recreates each xterm, which leaves terminal focus
// and PTY input in a bad state (Enter/keys not reaching the pty), especially
// with many Mission Control tiles mounting at once.
// A new install opens on the theme choice (components/Welcome.tsx), then the board.
// A detached project window never does: it exists because a project does.
function Root() {
	const [welcome, setWelcome] = useState<boolean | null>(
		window.ateam.window.boundProjectId() ? false : null,
	);
	useEffect(() => {
		if (welcome !== null) return;
		window.ateamTheme.firstRun().then(setWelcome, () => setWelcome(false));
	}, [welcome]);
	if (welcome === null) return null;
	return welcome ? <Welcome onDone={() => setWelcome(false)} /> : <App />;
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Root />);
}
