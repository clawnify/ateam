import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
	main: {
		// Externalize real npm deps (node-pty/better-sqlite3/drizzle/simple-git
		// load from node_modules at runtime), but BUNDLE the @grove/* workspace
		// packages — their entry points are raw TypeScript that node can't require.
		plugins: [
			externalizeDepsPlugin({
				exclude: [
					"@grove/git-core",
					"@grove/db",
					"@grove/agents",
					"@grove/panes",
				],
			}),
		],
		build: {
			rollupOptions: {
				input: {
					index: resolve(__dirname, "src/main/index.ts"),
					// The detached PTY daemon, built alongside main → out/main/daemon.js
					daemon: resolve(__dirname, "src/daemon/index.ts"),
				},
			},
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
		build: {
			rollupOptions: {
				input: { index: resolve(__dirname, "src/preload/index.ts") },
			},
		},
	},
	renderer: {
		root: resolve(__dirname, "src/renderer"),
		// Dedicated port so Grove never collides with other local dev servers
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
