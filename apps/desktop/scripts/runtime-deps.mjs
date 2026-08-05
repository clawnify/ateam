#!/usr/bin/env node

// Derive the packaged app's runtime dependencies from the BUILT bundle, instead
// of hand-maintaining a list in package-mac.sh.
//
// electron-vite externalizes some npm packages (they stay `require("x")` in
// out/) and bundles others. Which is which depends on the package's own shape
// (CJS/native → external, ESM → inlined), not on where it sits in
// package.json — so the only reliable source of truth is the emitted code.
// A hardcoded list silently ships a broken app the moment main imports a new
// external: `ws` landed in 0.1.35 that way and crashed every launch with
// "Cannot find module 'ws'" — past signing, notarization AND Gatekeeper, none
// of which check that a require() resolves.
//
// Usage:
//   node runtime-deps.mjs --deps <outDir>          → {"pkg":"^1.2.3",...} on stdout
//   node runtime-deps.mjs --verify-app <outDir> <Ateam.app>  → exit 1 if any is missing

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILTINS = new Set(builtinModules);
// Provided by the Electron runtime itself — never a node_modules entry.
const PROVIDED = new Set(["electron"]);

/**
 * Every bare `require("x")` specifier in the main + preload bundles.
 *
 * These bundles are CommonJS — electron-vite emits CJS unless package.json says
 * `"type": "module"`, which the desktop deliberately does not. So require() is
 * the only externalization form present, and a file with none of them means the
 * output format changed underneath us: fail loudly rather than report an empty
 * dependency set, which would sail through both gates and ship a broken app.
 */
function externalPackages(outDir) {
	const found = new Set();
	for (const sub of ["main", "preload"]) {
		const dir = join(outDir, sub);
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
			const code = readFileSync(join(dir, file), "utf8");
			const specs = [...code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)];
			if (specs.length === 0) {
				console.error(
					`FATAL: ${sub}/${file} contains no require() — the bundle is no ` +
						`longer CommonJS and this scanner cannot see its imports.`,
				);
				process.exit(1);
			}
			for (const [, spec] of specs) {
				if (spec.startsWith(".") || spec.startsWith("/")) continue;
				if (spec.startsWith("node:")) continue;
				// "@scope/name/deep" → "@scope/name"; "pkg/deep" → "pkg"
				const parts = spec.split("/");
				const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
				if (BUILTINS.has(name) || PROVIDED.has(name)) continue;
				found.add(name);
			}
		}
	}
	return [...found].sort();
}

const [mode, outDir, appPath] = process.argv.slice(2);
const names = externalPackages(outDir);

if (mode === "--deps") {
	const pkg = JSON.parse(readFileSync(join(DESKTOP_DIR, "package.json"), "utf8"));
	const declared = { ...pkg.devDependencies, ...pkg.dependencies };
	const deps = {};
	const missing = [];
	for (const name of names) {
		if (declared[name]) deps[name] = declared[name];
		else missing.push(name);
	}
	if (missing.length) {
		console.error(
			`FATAL: the built bundle requires ${missing.join(", ")}, which ` +
				`apps/desktop/package.json does not declare. Add it as a dependency.`,
		);
		process.exit(1);
	}
	process.stdout.write(JSON.stringify(deps, null, 4));
} else if (mode === "--verify-app") {
	// Last gate before publish: prove each require() actually resolves inside the
	// signed .app. electron-builder prunes devDependencies and can drop a package
	// entirely; only reading the shipped archive proves what made it in.
	const resources = join(appPath, "Contents/Resources");
	// @electron/asar comes free with electron-builder in the staging dir, which is
	// three levels up from the .app ($STAGE/release/mac-arm64/Ateam.app).
	const require = createRequire(import.meta.url);
	const asar = require(join(appPath, "../../..", "node_modules/@electron/asar"));
	const entries = new Set(asar.listPackage(join(resources, "app.asar")));
	const missing = names.filter(
		(name) =>
			!entries.has(`/node_modules/${name}`) &&
			!existsSync(join(resources, "app.asar.unpacked/node_modules", name)),
	);
	if (missing.length) {
		console.error(
			`FATAL: ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} ` +
				`require()d by the bundle but absent from the packaged app — it ` +
				`would crash on launch. Refusing to ship.`,
		);
		process.exit(1);
	}
	console.log(`   ok: all ${names.length} runtime deps present (${names.join(", ")})`);
} else {
	console.error("usage: runtime-deps.mjs --deps <outDir> | --verify-app <outDir> <app>");
	process.exit(2);
}
