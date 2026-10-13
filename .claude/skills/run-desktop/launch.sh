#!/bin/bash
# Build and launch the Ateam desktop app against a throwaway user-data dir with
# CDP enabled, so an agent can drive it without touching the developer's real
# app data (or whatever dev instance is already running from another worktree).
#
#   bash .claude/skills/run-desktop/launch.sh <data-dir> [cdp-port]
#
# Run it in the BACKGROUND and read its output file — do NOT pipe it through
# `tail`, which buffers stdout and swallows the startup error you need.
set -e

DATA_DIR="${1:?usage: launch.sh <data-dir> [cdp-port]}"
PORT="${2:-9333}"
ROOT="$(git rev-parse --show-toplevel)"
mkdir -p "$DATA_DIR"

cd "$ROOT"
[ -d node_modules ] || bun install

# A fresh `bun install` can land the x86_64 prebuild of better-sqlite3 even on
# Apple silicon; the app then dies at startup with ERR_DLOPEN_FAILED. Rebuild
# the native modules against Electron's ABI whenever the arch doesn't match.
NATIVE=$(echo node_modules/.bun/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node)
if [ ! -f "$NATIVE" ] || ! file "$NATIVE" | grep -q "$(uname -m)"; then
  echo "[launch] native modules are not $(uname -m) — rebuilding for Electron"
  (cd apps/desktop && bun run rebuild)
fi

(cd apps/desktop && bun run build)

echo "[launch] user-data-dir=$DATA_DIR cdp=$PORT"
cd apps/desktop
exec bunx electron . --user-data-dir="$DATA_DIR" --remote-debugging-port="$PORT"
