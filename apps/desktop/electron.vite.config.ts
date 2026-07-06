import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

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
		// Dedicated port so Ateam never collides with other local dev servers
		// (e.g. another project on the default 5173). strictPort surfaces a clash
		// instead of silently hopping to a different port.
		server: { port: 5219, strictPort: true },
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
