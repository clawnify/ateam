#!/usr/bin/env bash
# Build a signed + notarized macOS release from a staging dir with REAL
# node_modules (electron-builder can't package Bun's symlinked workspace).
#
# The staging dir is recreated on demand, so it survives `/tmp` being cleared.
# Usage:  bash scripts/package-mac.sh
# Output: $STAGE/release/{Ateam-macos.dmg, Ateam-<ver>-arm64-mac.zip, latest-mac.yml}
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="${ATEAM_STAGE:-$HOME/.cache/ateam-pkg}"   # stable, not /tmp
VERSION="$(node -p "require('$DESKTOP_DIR/package.json').version")"
ELECTRON_VER="$(node -p "require('$DESKTOP_DIR/package.json').devDependencies.electron")"
BUILDER_VER="$(node -p "require('$DESKTOP_DIR/package.json').devDependencies['electron-builder']")"
NOTARIZE_VER="$(node -p "require('$DESKTOP_DIR/package.json').devDependencies['@electron/notarize']")"
REBUILD_VER="$(node -p "require('$DESKTOP_DIR/package.json').devDependencies['@electron/rebuild']")"
SQLITE_VER="$(node -p "require('$DESKTOP_DIR/package.json').dependencies['better-sqlite3']")"
PTY_VER="$(node -p "require('$DESKTOP_DIR/package.json').dependencies['node-pty']")"

echo "==> Ateam $VERSION → staging at $STAGE"
mkdir -p "$STAGE"

# 1. Staging package.json (only runtime native deps live in node_modules; the
#    rest is bundled into out/ by electron-vite). electron-updater is a runtime
#    dep and MUST be present so the externalized require resolves.
cat > "$STAGE/package.json" <<JSON
{
  "name": "ateam",
  "version": "$VERSION",
  "main": "out/main/index.js",
  "author": "Clawnify",
  "dependencies": {
    "better-sqlite3": "$SQLITE_VER",
    "node-pty": "$PTY_VER",
    "electron-updater": "$(node -p "require('$DESKTOP_DIR/package.json').dependencies['electron-updater']")"
  },
  "devDependencies": {
    "electron": "$ELECTRON_VER",
    "electron-builder": "$BUILDER_VER",
    "@electron/notarize": "$NOTARIZE_VER",
    "@electron/rebuild": "$REBUILD_VER"
  }
}
JSON

# 2. Install + rebuild native modules for Electron's arm64 ABI. Recreated when
#    the install is missing or incomplete (e.g. a partial install left behind by
#    a wiped/interrupted run) — checks for the actual binaries it needs.
if [ ! -x "$STAGE/node_modules/.bin/electron-builder" ] ||
   [ ! -x "$STAGE/node_modules/.bin/electron-rebuild" ] ||
   [ ! -d "$STAGE/node_modules/electron/dist" ]; then
  echo "==> npm install (first run / staging cleared or incomplete)"
  rm -rf "$STAGE/node_modules" "$STAGE/package-lock.json"
  ( cd "$STAGE" && npm install --no-audit --no-fund )
  echo "==> electron-rebuild better-sqlite3 + node-pty (arm64)"
  ( cd "$STAGE" && ./node_modules/.bin/electron-rebuild -f -w better-sqlite3,node-pty --arch arm64 )
fi

# 3. Fresh production bundle, copied into staging.
echo "==> electron-vite build"
( cd "$DESKTOP_DIR" && bunx --bun electron-vite build )
rm -rf "$STAGE/out" "$STAGE/build" "$STAGE/scripts" "$STAGE/electron-builder.yml" "$STAGE/release"
cp -R "$DESKTOP_DIR/out" "$DESKTOP_DIR/build" "$DESKTOP_DIR/scripts" "$STAGE/"
cp "$DESKTOP_DIR/electron-builder.yml" "$STAGE/"

# 4. Sign + notarize + staple + dmg + zip (no target args: the yml declares both).
echo "==> electron-builder (sign + notarize + dmg + zip)"
( cd "$STAGE" && ./node_modules/.bin/electron-builder --mac --arm64 )

# 4b. Fail loudly if the packaged native module isn't arm64. npmRebuild is off
#     (electron-builder trusts the prebuilt modules), and step 2's rebuild is
#     skipped whenever the staging node_modules already exists — so a stale
#     x86_64 better-sqlite3 in the cache silently ships an app that dlopen()s
#     the wrong arch and launches with no window. This shipped as 0.1.24.
NODE_MODULE="$STAGE/release/mac-arm64/Ateam.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if ! file "$NODE_MODULE" | grep -q "arm64"; then
  echo "ERROR: packaged better_sqlite3.node is not arm64 — refusing to ship." >&2
  file "$NODE_MODULE" >&2
  echo "Fix: wipe the staging dir so the arm64 rebuild reruns (rm -rf \"$STAGE/node_modules\")." >&2
  exit 1
fi
echo "==> native module arch OK (arm64)"

echo "==> Gatekeeper check"
spctl -a -vv -t install "$STAGE/release/mac-arm64/Ateam.app" 2>&1 | tail -2

echo "==> Done. Artifacts:"
ls -1 "$STAGE"/release/{Ateam-macos.dmg,Ateam-$VERSION-arm64-mac.zip,latest-mac.yml}
