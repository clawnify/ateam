// Build the standalone `ateam` server dist for a remote box: the CLI + the PTY
// daemon, bundled to CJS with the two NATIVE modules externalized. Everything
// else (drizzle, simple-git, @xterm, the @ateam/* workspace packages) is bundled
// in. The box installs only better-sqlite3 + node-pty for its own arch — and
// since the box has no compiler, node-pty is aliased to the prebuilt fork and
// better-sqlite3 uses its node prebuilds (see the emitted dist/package.json).
//
// CJS (not ESM) is deliberate: simple-git pulls @kwsites/file-exists, which does
// a bare `require`, and that breaks under a bundled-ESM output.
//
// Two single-entry bundles, not one multi-entry: bun preserves each entry's
// src-relative path, which would put the daemon at dist/pty/daemon.js — but
// cli.ts resolves the daemon as `daemon.js` BESIDE itself. Building each alone
// flattens both to the dist root.
//
// Output: dist/{cli.js, daemon.js, desktop.js, desktop-wallpaper.png, package.json, install-browser.sh}.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(serverRoot, "dist");
// native — installed on the box; the last two are `ws`'s OPTIONAL native speedups
// (it try/catch-requires them and falls back to pure JS), so leave them unbundled.
const EXTERNAL = ["better-sqlite3", "node-pty", "bufferutil", "utf-8-validate"];

// The release this engine belongs to: the desktop app's version, which the release
// flow bumps in the commit it tags (CI builds the box tarball from that tag). The
// engine reports it in system:hello (src/release.ts).
const release: string = JSON.parse(
	readFileSync(join(serverRoot, "..", "..", "apps", "desktop", "package.json"), "utf8"),
).version;

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
copyFileSync(join(serverRoot, "scripts", "install-browser.sh"), join(dist, "install-browser.sh"));

for (const entry of ["src/cli.ts", "src/pty/daemon.ts", "../desktop-control/src/desktop.ts"]) {
	const res = await Bun.build({
		entrypoints: [join(serverRoot, entry)],
		outdir: dist,
		target: "node",
		format: "cjs",
		external: EXTERNAL,
		define: { ATEAM_RELEASE: JSON.stringify(release) },
	});
	if (!res.success) {
		for (const log of res.logs) console.error(log);
		process.exit(1);
	}
}

copyFileSync(
	join(serverRoot, "../desktop-control/assets/wallpaper.png"),
	join(dist, "desktop-wallpaper.png"),
);

// The box runs `npm install` here to fetch ONLY the two native modules for its
// own platform; the aliased fork ships prebuilt binaries so no compiler is needed.
writeFileSync(
	join(dist, "package.json"),
	`${JSON.stringify(
		{
			name: "ateam-server-dist",
			version: release,
			private: true,
			ateamLifecycle: 1,
			bin: { ateam: "./cli.js" },
			dependencies: {
				// 13, not the ^11 the workspace pins (the desktop runs its engine inside
				// Electron, with its own copy). 11.x aborts at startup on newer Node 24
				// (boxd's image ships v24.21.0): `Assertion failed: (env) != nullptr` in
				// RemoveEnvironmentCleanupHook, before the engine logs a line. 13 ships
				// its Node-API binaries inside the package, so the box still needs no
				// compiler and one build serves Node 22 and 24.
				"better-sqlite3": "^13.0.3",
				"node-pty": "npm:@homebridge/node-pty-prebuilt-multiarch@^0.13.1",
			},
		},
		null,
		2,
	)}\n`,
);

console.log(`built ateam ${release} dist → ${dist}`);
