import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

// Note: intentionally NOT wrapped in <StrictMode>. Its dev-only double
// mount/unmount disposes and recreates each xterm, which leaves terminal focus
// and PTY input in a bad state (Enter/keys not reaching the pty), especially
// with many Mission Control tiles mounting at once.
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<App />);
}
