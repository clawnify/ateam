import { createHash } from "node:crypto";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// Dev server address. Two hazards here, and only fixing both is enough.
//
// host: Vite binds "localhost" by default, which resolves to ::1 for the first
// process and falls through to 127.0.0.1 for the second, so two worktrees can
// BOTH "successfully" bind the same port. Neither bind fails, so strictPort
// never fires (it is only an EADDRINUSE handler on its own listen). electron-vite
// then points Electron at http://localhost:<port>, which resolves to whichever
// of the two it likes, and you silently get another worktree's renderer with no
// error anywhere. Pinning one address family makes a real clash a real EADDRINUSE.
//
// port: this repo is developed across dozens of worktrees at once, which is the
// whole point of the product, so one fixed port would only move the pain to "the
// second worktree cannot run dev at all". Derive a stable port from the worktree
// path instead: the same worktree gets the same port every run, different
// worktrees do not collide, and if two ever hash together the pinned host makes
// it fail loudly rather than serve the wrong code.
//
// Not `strictPort: false`: Vite would hop to a free port but keeps the bound one
// in a private field, never writing it back to config.server.port, which is the
// field electron-vite reads to build ELECTRON_RENDERER_URL. Hopping would point
// Electron at the port we did NOT get, guaranteeing the bug rather than risking it.
const devPort = 5219 + (createHash("sha1").update(__dirname).digest().readUInt16BE(0) % 300);

export default defineConfig({
	main: {
		// Externalize real npm deps (node-pty/better-sqlite3/drizzle/simple-git
		// load from node_modules at runtime), but BUNDLE the @ateam/* workspace
		// packages — their entry points are raw TypeScript that node can't require.
		plugins: [
			externalizeDepsPlugin({
				exclude: [
					"@ateam/git-core",
					"@ateam/db",
					"@ateam/agents",
					"@ateam/panes",
					"@ateam/protocol",
					"@ateam/server",
				],
			}),
		],
		build: {
			rollupOptions: {
				input: {
					// The entry point electron actually loads: a crash guard that
					// require()s index.js at runtime. A separate input on purpose —
					// bundled together, its try/catch could never see index's throw.
					bootstrap: resolve(__dirname, "src/main/bootstrap.ts"),
					index: resolve(__dirname, "src/main/index.ts"),
					// The detached PTY daemon, built alongside main → out/main/daemon.js.
					// Source lives in @ateam/server (its PTY subsystem); the desktop and
					// the server dist bundle the one file. node-pty/@xterm stay desktop
					// deps too, so electron-rebuild + runtime resolution are unchanged.
					daemon: resolve(__dirname, "../../packages/server/src/pty/daemon.ts"),
				},
			},
		},
	},
	preload: {
		// Bundle @ateam/protocol (raw TS, and CH is used at runtime here); keep
		// real npm deps externalized as usual.
		plugins: [externalizeDepsPlugin({ exclude: ["@ateam/protocol"] })],
		build: {
			rollupOptions: {
				input: { index: resolve(__dirname, "src/preload/index.ts") },
			},
		},
	},
	renderer: {
		root: resolve(__dirname, "src/renderer"),
		// Dev server address. See devPort above for why both halves matter.
		server: { host: "127.0.0.1", port: devPort, strictPort: true },
		resolve: {
			alias: { "@": resolve(__dirname, "src/renderer/src") },
		},
		plugins: [react()],
		build: {
			rollupOptions: {
				input: { index: resolve(__dirname, "src/renderer/index.html") },
			},
		},
	},
});
