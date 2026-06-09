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

# 2. Install + rebuild native modules for Electron's arm64 ABI (only when the
#    install is missing/stale — survives a wiped staging dir).
if [ ! -d "$STAGE/node_modules/electron" ]; then
  echo "==> npm install (first run / staging was cleared)"
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

echo "==> Gatekeeper check"
spctl -a -vv -t install "$STAGE/release/mac-arm64/Ateam.app" 2>&1 | tail -2

echo "==> Done. Artifacts:"
ls -1 "$STAGE"/release/{Ateam-macos.dmg,Ateam-$VERSION-arm64-mac.zip,latest-mac.yml}
