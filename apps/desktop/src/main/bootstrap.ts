// The app's real entry point — a crash guard around the main bundle.
//
// When main fails while being require()d the app is unrecoverable from the
// inside: no window exists, so no in-app button can be reached, and
// electron-updater never runs, so the app cannot update itself out of a bad
// release. All the user gets is Electron's default "A JavaScript error occurred
// in the main process" dialog — a stack trace and an OK button, nothing
// actionable. 0.1.35 shipped without `ws` and bricked exactly that way, as did
// 0.1.24 and 0.1.26 on an x86_64 better-sqlite3, which index.js requires at top
// level.
//
// So the entry point is this file, and load-time failure becomes a dialog that
// offers the one fix reachable from outside a dead app. Failures *after* load
// are a different branch — index.ts catches those — but both end up in the same
// showStartupFailure(), so the two can't drift apart.
//
// Two constraints keep the guard trustworthy, both enforced by the build:
//   1. Nothing here resolves at runtime except `electron`. The local imports are
//      inlined into this chunk by the bundler, so a missing package — precisely
//      what the guard exists to survive — is never require()d to reach it.
//   2. It is a separate rollup input, so `require("./index.js")` stays a real
//      runtime require. Inlined into the main chunk, the throw would happen
//      before this try block and the guard would never fire.
//
// Not covered: crashes inside Electron's own startup, which never reach JS, and
// the detached PTY daemon, which is its own process (a dead daemon costs
// terminals, not the app — index.ts degrades rather than blocking on it).

import { showStartupFailure } from "./startup-failure";

try {
	require("./index.js");
} catch (err) {
	showStartupFailure(err, "load");
}
