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
// Output: dist/{cli.js, daemon.js, package.json}. Run: `bun run build`.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(serverRoot, "dist");
// native — installed on the box; the last two are `ws`'s OPTIONAL native speedups
// (it try/catch-requires them and falls back to pure JS), so leave them unbundled.
const EXTERNAL = ["better-sqlite3", "node-pty", "bufferutil", "utf-8-validate"];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const entry of ["src/cli.ts", "src/pty/daemon.ts"]) {
	const res = await Bun.build({
		entrypoints: [join(serverRoot, entry)],
		outdir: dist,
		target: "node",
		format: "cjs",
		external: EXTERNAL,
	});
	if (!res.success) {
		for (const log of res.logs) console.error(log);
		process.exit(1);
	}
}

// The box runs `npm install` here to fetch ONLY the two native modules for its
// own platform; the aliased fork ships prebuilt binaries so no compiler is needed.
writeFileSync(
	join(dist, "package.json"),
	`${JSON.stringify(
		{
			name: "ateam-server-dist",
			version: "0.0.0",
			private: true,
			bin: { ateam: "./cli.js" },
			dependencies: {
				"better-sqlite3": "^11.8.1",
				"node-pty": "npm:@homebridge/node-pty-prebuilt-multiarch@^0.13.1",
			},
		},
		null,
		2,
	)}\n`,
);

console.log(`built ateam dist → ${dist}`);
