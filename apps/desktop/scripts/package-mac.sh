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

# Fail unless every compiled native module under $1 is a single-arch arm64
# binary. Scans only `*/build/Release/*.node` — the electron-rebuild output that
# actually gets dlopen()ed on darwin-arm64 — and deliberately skips the
# `prebuilds/` tree node-pty ships (win32-*/darwin-x64 binaries that are never
# loaded on this platform). Uses `lipo -archs`, which prints ONLY the arch(s)
# ("arm64" / "x86_64" / a fat "x86_64 arm64") — never the path. The old check
# `file "$f" | grep arm64` false-passed because `file` echoes the path, which
# contains "mac-arm64"; that no-op guard is why x86_64 shipped in 0.1.24 + 0.1.26.
assert_arm64_nodes() {
  local root="$1" f archs bad=0 n=0
  while IFS= read -r f; do
    n=$((n + 1))
    archs="$(lipo -archs "$f" 2>/dev/null || true)"
    if [ "$archs" != "arm64" ]; then
      echo "   !! $f is [${archs:-unknown}], expected arm64" >&2
      bad=1
    fi
  done < <(find "$root" -path '*/build/Release/*.node' 2>/dev/null)
  # A zero-match scan means the module layout changed — fail closed rather than
  # green-light a build we never actually verified.
  if [ "$n" -eq 0 ]; then
    echo "   !! no build/Release/*.node found under $root" >&2
    bad=1
  fi
  return $bad
}

# 2. Install + rebuild native modules for Electron's arm64 ABI. Recreated when
#    the install is missing or incomplete (e.g. a partial install left behind by
#    a wiped/interrupted run) — checks for the actual binaries it needs.
if [ ! -x "$STAGE/node_modules/.bin/electron-builder" ] ||
   [ ! -x "$STAGE/node_modules/.bin/electron-rebuild" ] ||
   [ ! -d "$STAGE/node_modules/electron/dist" ]; then
  echo "==> npm install (first run / staging cleared or incomplete)"
  rm -rf "$STAGE/node_modules" "$STAGE/package-lock.json"
  ( cd "$STAGE" && npm install --no-audit --no-fund )
fi

# electron-rebuild is idempotent and cheap once the toolchain is warm, so run it
# every build — NOT only when node_modules was just created. A pre-existing
# staging dir can hold a stale/wrong-arch prebuild (npm fetches a host-arch,
# Node-ABI binary; only electron-rebuild produces the arm64 Electron-ABI one).
# Then verify: if the staged modules still aren't arm64, abort before we sign.
echo "==> electron-rebuild better-sqlite3 + node-pty (arm64)"
( cd "$STAGE" && ./node_modules/.bin/electron-rebuild -f -w better-sqlite3,node-pty --arch arm64 )
if ! assert_arm64_nodes "$STAGE/node_modules/better-sqlite3" ||
   ! assert_arm64_nodes "$STAGE/node_modules/node-pty"; then
  echo "FATAL: staged native modules are not arm64 after electron-rebuild." >&2
  echo "       Is 'node' running under Rosetta? (arch: $(node -p process.arch))" >&2
  exit 1
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

# 4b. Hard gate: every native module packaged into the .app must be arm64.
#     Signing, notarization and the spctl check below are all arch-agnostic and
#     will happily bless an x86_64 module that then dlopen()-crashes on every
#     Apple Silicon Mac — so this is the last line of defense before publish.
echo "==> Architecture check (native modules must be arm64)"
if ! assert_arm64_nodes "$STAGE/release/mac-arm64/Ateam.app"; then
  echo "FATAL: packaged .app contains non-arm64 native modules — refusing to ship." >&2
  echo "Fix: wipe the staging dir so the arm64 rebuild reruns (rm -rf \"$STAGE/node_modules\")." >&2
  exit 1
fi
echo "   ok: all *.node in Ateam.app are arm64"

echo "==> Gatekeeper check"
spctl -a -vv -t install "$STAGE/release/mac-arm64/Ateam.app" 2>&1 | tail -2

echo "==> Done. Artifacts:"
ls -1 "$STAGE"/release/{Ateam-macos.dmg,Ateam-$VERSION-arm64-mac.zip,latest-mac.yml}
