#!/usr/bin/env bash
# Typecheck every workspace project. Each package/app tsconfig is a standalone
# `noEmit` config — the repo has no composite build graph, so `tsc -b` doesn't
# apply. Check them one by one; run all before exiting so contributors see every
# project's errors at once, not just the first that fails.
set -uo pipefail
cd "$(dirname "$0")/.."

configs=(
  apps/desktop/tsconfig.node.json
  apps/desktop/tsconfig.web.json
  packages/*/tsconfig.json
)

status=0
for cfg in "${configs[@]}"; do
  echo "▸ tsc -p $cfg"
  ./node_modules/.bin/tsc --noEmit -p "$cfg" || status=1
done
exit "$status"
