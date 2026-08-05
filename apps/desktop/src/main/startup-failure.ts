// The one place a "couldn't start" failure is shown to the user.
//
// Startup can fail in two places, and before this they were handled separately
// with different wording and different capability:
//
//   load     the main bundle throws while being require()d — a missing module
//            (0.1.35 shipped without `ws`) or a wrong-arch better-sqlite3, which
//            index.js requires at top level. Caught by bootstrap.ts.
//   startup  the app is ready but createEngine() throws — schema DDL, a corrupt
//            database, an unreadable data dir. Caught by index.ts.
//
// Both leave the user with a dead app and no way forward, so both get the same
// dialog and the same escape hatch. Keeping them in one function is what stops
// them drifting apart again: the load path is nearly extinct now that the build
// gates every require() and every native module's arch, while the startup path
// is data-dependent and therefore permanent — exactly the one that must not be
// the neglected branch.
//
// Constraint inherited from bootstrap.ts: this module must resolve NOTHING at
// runtime except `electron`. Its own imports are a bare string constant and
// electron itself, so the bundler inlines it into both entry chunks and no
// require() of a possibly-missing package is ever reached.

import { app, dialog, shell } from "electron";
import { APP_NAME } from "./app-name";

const DOWNLOAD_URL = "https://github.com/clawnify/ateam/releases/latest/download/Ateam-macos.dmg";

type Phase = "load" | "startup";

// A broken build and broken local data need different words. Telling someone
// already on the newest release that "this version is broken, install the
// latest" sends them in a circle, so only the load path — which really does
// mean the build is bad — makes that claim.
const EXPLANATION: Record<Phase, string> = {
	load: "This version is broken. Installing the latest version usually fixes it — your projects and sessions are kept.",
	startup: `${APP_NAME} got as far as starting up, then stopped. Installing the latest version is the usual fix; if it keeps happening, the error above is the detail to report.`,
};

/**
 * Show the failure, offer the only remedy that works from outside a dead app,
 * and exit. Never returns.
 */
export function showStartupFailure(err: unknown, phase: Phase): void {
	// The full error (stack, require stack) goes to stderr, where a terminal
	// launch or Console.app keeps it for a bug report. The dialog gets the first
	// line only — Node folds the whole require stack into .message, which turns
	// the box into a wall of paths nobody reads.
	console.error(`[ateam] ${phase} failed:`, err);
	const summary = (err instanceof Error ? err.message : String(err)).split("\n")[0];

	// Safe on both paths: already resolved when index.ts calls it, still pending
	// when bootstrap.ts does.
	app.whenReady().then(async () => {
		const { response } = await dialog.showMessageBox({
			type: "error",
			message: `${APP_NAME} couldn't start`,
			detail: `${summary}\n\n${EXPLANATION[phase]}`,
			buttons: ["Download latest version", "Quit"],
			defaultId: 0,
			cancelId: 1,
		});
		if (response === 0) await shell.openExternal(DOWNLOAD_URL);
		// exit, not quit: quit runs before-quit/window-all-closed handlers, and on
		// the startup path those belong to a half-initialised app that may throw
		// again. There is nothing left worth shutting down cleanly.
		app.exit(1);
	});
}
