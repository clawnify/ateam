#!/usr/bin/env bash
# Install the `ateam` server on a remote box FROM THIS CHECKOUT — the dev
# counterpart to the public installer, for testing a build before it's released.
#
#   scripts/install-remote.sh <ssh-destination>
#   SSH_FLAGS="-i ~/.ssh/mykey" scripts/install-remote.sh user@host
#
# It only builds the tarball and ships it: the actual install is `install.sh`
# run on the box against that local tarball, so there is ONE install code path
# (node selection, native modules, launcher, login PATH, handshake) and a dev
# deploy exercises exactly what a user's `curl … | bash` does.
#
# Files/dirs are only ever created or overwritten, never removed.
set -euo pipefail

HOST="${1:?usage: install-remote.sh <ssh-destination> (user@host or an ssh_config alias)}"
SSH_FLAGS="${SSH_FLAGS:-}"
HERE="$(cd "$(dirname "$0")/.." && pwd)" # packages/server

echo "==> build dist + tarball (bun bundle)"
(cd "$HERE" && bun run build:release >/dev/null)

echo "==> ship to $HOST"
scp ${SSH_FLAGS} -q "$HERE/dist/ateam-server.tar.gz" "$HERE/scripts/install.sh" "$HOST:/tmp/"

echo "==> install on $HOST"
ssh ${SSH_FLAGS} "$HOST" 'ATEAM_TARBALL=/tmp/ateam-server.tar.gz bash /tmp/install.sh'
