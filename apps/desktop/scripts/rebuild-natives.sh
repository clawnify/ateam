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

# `bun run` executes lifecycle scripts with the first `bash` on PATH. When that is
# an x86_64-only bash (an Intel Homebrew under /usr/local is the usual source), this
# script and every child it spawns run TRANSLATED: `uname -m` reports x86_64 on an
# M-series Mac and prebuild-install sees process.arch as x64, which is how a
# darwin-x64 better-sqlite3 lands in the worktree. macOS also attributes translated
# processes to the app that owns the terminal, which is what raises "Support Ending
# for Intel-Based Apps" against Ateam. Re-exec natively so node-gyp, python3 and cc
# below all run arm64; after the re-exec proc_translated is 0, so this runs once.
if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ] &&
	[ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ] &&
	[ -x /usr/bin/arch ] && [ -x /bin/bash ]; then
	exec /usr/bin/arch -arm64 /bin/bash "$0" "$@"
fi

# `sysctl hw.optional.arm64` describes the HARDWARE, not the calling process, so it
# stays honest even on a machine where the re-exec above could not run.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then
	ARCH=arm64
else
	ARCH=x64
fi

exec electron-rebuild -f -w better-sqlite3,node-pty --arch "$ARCH"
