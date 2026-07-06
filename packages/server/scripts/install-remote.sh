#!/usr/bin/env bash
# One-shot installer: build the `ateam` server dist locally and install it on a
# remote box over SSH, then verify the handshake. Proven against a Hetzner box
# (Ubuntu, node via nvm).
#
#   scripts/install-remote.sh <ssh-destination>
#   SSH_FLAGS="-i ~/.ssh/mykey" scripts/install-remote.sh user@host
#
# The box needs a node 22.x (via nvm): better-sqlite3 ships node-22 prebuilds and
# node-pty is the prebuilt fork, so NO compiler is required. Agent CLIs (claude,
# codex, …) are discovered at connect time from a login shell, so they can live
# anywhere on the login PATH — the installer doesn't need to know where.
#
# Files/dirs are only ever created or overwritten, never removed.
set -euo pipefail

HOST="${1:?usage: install-remote.sh <ssh-destination> (user@host or an ssh_config alias)}"
SSH_FLAGS="${SSH_FLAGS:-}"
APP_DIR="ateam-app" # under the remote home
HERE="$(cd "$(dirname "$0")/.." && pwd)" # packages/server
run() { ssh ${SSH_FLAGS} "$HOST" "$@"; }

echo "==> [1/6] build dist (bun bundle)"
(cd "$HERE" && bun run build >/dev/null)

echo "==> [2/6] locate node 22 on $HOST"
N22="$(run 'ls -d "$HOME"/.nvm/versions/node/v22* 2>/dev/null | tail -1')/bin/node"
run "test -x '$N22'" || {
	echo "!! node 22 not found on $HOST — run 'nvm install 22' there first"
	exit 1
}
echo "    node: $N22"

echo "==> [3/6] copy dist to ~/$APP_DIR"
run "mkdir -p ~/$APP_DIR ~/.local/bin"
scp ${SSH_FLAGS} -q "$HERE/dist/cli.js" "$HERE/dist/daemon.js" "$HERE/dist/package.json" "$HOST:$APP_DIR/"

echo "==> [4/6] install native modules (node 22 prebuilds; no compiler)"
run "PATH=\"$(dirname "$N22")\":\$PATH; cd ~/$APP_DIR && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1"

echo "==> [5/6] install the 'ateam' launcher on the login PATH (~/.local/bin/ateam)"
# Generated locally (with node 22 pinned) and copied, to sidestep ssh quoting.
# It runs cli.js under node 22 (matching the native ABI); a login shell around it
# supplies the PATH that resolves agent CLIs.
WRAP="$(mktemp)"
printf '#!/bin/sh\nexec %s "$HOME/%s/cli.js" "$@"\n' "$N22" "$APP_DIR" >"$WRAP"
scp ${SSH_FLAGS} -q "$WRAP" "$HOST:.local/bin/ateam"
rm -f "$WRAP"
run "chmod +x ~/.local/bin/ateam"

echo "==> [6/6] verify handshake over a login shell (~10s)"
REQ="$(mktemp)"
printf '{"t":"req","id":1,"method":"system:hello","args":[]}\n' >"$REQ"
# `attach` is a persistent relay — it won't self-exit after the reply, so cap it
# with `timeout` and tolerate that non-zero exit (|| true); we only need the one
# reply line. A persistent client (the desktop) keeps the connection open and is
# unaffected by this one-shot pattern.
OUT="$(ssh ${SSH_FLAGS} "$HOST" "bash -lc 'timeout 12 ateam attach --stdio'" <"$REQ" 2>/dev/null | head -1 || true)"
rm -f "$REQ"
case "$OUT" in
*protocolVersion*) echo "    OK  $OUT" ;;
*)
	echo "!! handshake failed: ${OUT:-<no reply>}"
	exit 1
	;;
esac

echo
echo "Installed. A client connects to this host with:"
echo "    bash -lc 'exec ateam attach --stdio'"
