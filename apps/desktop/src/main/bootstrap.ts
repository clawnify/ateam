// The app's real entry point — a crash guard around the main bundle.
//
// When main fails at load time the app is unrecoverable from the inside: no
// window exists, so no in-app button can be reached, and electron-updater never
// runs, so the app cannot update itself out of a bad release. All the user gets
// is Electron's default "A JavaScript error occurred in the main process" dialog
// — a stack trace and an OK button, nothing actionable. 0.1.35 shipped without
// `ws` and bricked that way; 0.1.24 and 0.1.26 shipped x86_64 native modules and
// bricked the same way.
//
// So the entry point is this file instead, and it catches the whole class:
// missing module, wrong-arch .node, corrupt asar, a throwing migration — any
// load-time failure becomes a dialog that offers the one fix that works, a fresh
// download.
//
// Two constraints keep it trustworthy, both enforced by the build:
//   1. It imports NOTHING but `electron`. A bundled dependency is exactly what
//      might be missing, and the guard must survive that.
//   2. It is a separate rollup input, so `require("./index.js")` stays a real
//      runtime require. Inlined into the main chunk, the throw would happen
//      before this try block and the guard would never fire.
//
// It does not cover async failures after load, or a crash inside Electron's own
// startup — those never reach JS. Every incident so far has been load-time.

import { app, dialog, shell } from "electron";

const DOWNLOAD_URL = "https://github.com/clawnify/ateam/releases/latest/download/Ateam-macos.dmg";

try {
	require("./index.js");
} catch (err) {
	// First line only — Node folds the whole require stack into .message, which
	// turns the dialog into a wall of paths nobody reads. The full error goes to
	// stderr, where a terminal launch or Console.app keeps it for a bug report.
	const message = (err instanceof Error ? err.message : String(err)).split("\n")[0];
	console.error("[bootstrap] main process failed to load:", err);

	app.whenReady().then(async () => {
		const { response } = await dialog.showMessageBox({
			type: "error",
			message: `${app.getName()} couldn't start`,
			detail:
				`${message}\n\nThis version is broken. Installing the latest ` +
				`version usually fixes it — your projects and sessions are kept.`,
			buttons: ["Download latest version", "Quit"],
			defaultId: 0,
			cancelId: 1,
		});
		if (response === 0) await shell.openExternal(DOWNLOAD_URL);
		app.quit();
	});
}
