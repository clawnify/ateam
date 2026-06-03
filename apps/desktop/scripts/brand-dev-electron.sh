#!/bin/bash
# Brand the prebuilt dev Electron bundle so the macOS dock/menu shows "Ateam"
# instead of "Electron" during development. Packaged builds set their own name
# (electron-builder productName), so this only matters for `electron-vite dev`.
# Idempotent; re-run on every `dev` so it survives `electron` reinstalls.
set -e
APP_NAME="Ateam"

# `require('electron')` from plain Node returns the path to the binary.
BIN="$(node -p "require('electron')" 2>/dev/null || true)"
[ -z "$BIN" ] && { echo "[brand] electron not found, skipping"; exit 0; }

PLIST="$(dirname "$(dirname "$BIN")")/Info.plist" # .../Contents/Info.plist
[ -f "$PLIST" ] || { echo "[brand] Info.plist not found at $PLIST, skipping"; exit 0; }

set_key() {
  /usr/libexec/PlistBuddy -c "Set :$1 $APP_NAME" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :$1 string $APP_NAME" "$PLIST"
}
set_key CFBundleName
set_key CFBundleDisplayName
echo "[brand] dev Electron branded as \"$APP_NAME\""
