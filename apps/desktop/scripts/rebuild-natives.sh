#!/usr/bin/env bash
# Rebuild the native modules Electron dlopen()s, so a fresh checkout — or a new
# task worktree — is runnable straight after `bun install`, with no second step.
#
# Why this is an install hook and not a documented command: `bun install` fetches
# better-sqlite3 built for the host's *Node* ABI, which Electron cannot load, and
# on Apple Silicon it fetches the wrong architecture too (see below). As a manual
# step it got skipped: 17 of the 30 worktrees that had deps installed were holding
# an unloadable x86_64 binary when this hook was added.
#
# `-f` is required, not defensive: without it electron-rebuild treats the x86_64
# binary bun just downloaded as already-built and skips it, leaving the worktree
# broken. Measured cost of forcing: ~10s once per install. The release path runs
# its own forced rebuild inside the staging dir (see package-mac.sh).
set -euo pipefail

# CI installs the workspace on Linux to typecheck and test; no Electron there.
[ "$(uname -s)" = Darwin ] || exit 0

# Everything bun's script runner spawns runs TRANSLATED: it picks the x86_64
# slice of universal binaries, so inside this script `uname -m` reports x86_64
# and `arch` reports i386 even on an M-series Mac. That is also why bun's install
# leaves a darwin-x64 better-sqlite3 behind: prebuild-install sees process.arch
# as x64. `sysctl hw.optional.arm64` describes the HARDWARE, not the calling
# process, so it survives the translation and is the one honest probe here.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then
	ARCH=arm64
else
	ARCH=x64
fi

exec electron-rebuild -f -w better-sqlite3,node-pty --arch "$ARCH"
