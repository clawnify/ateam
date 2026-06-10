import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

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
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<App />);
}
