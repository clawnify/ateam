#!/usr/bin/env bash
# Serve this worktree's JS to the "Ateam Go Dev" app on your iPhone, over the
# tailnet only:  https://<this box>.<tailnet>.ts.net:8443  ->  Metro on 8082.
# Never put Metro on a public URL (no public proxy URL): its debugger endpoint has no auth.
# JS edits reload on the phone. Native changes (modules/, new native packages,
# app.json plugins) need a new `npm run ios:dev` build on the Mac.
# When done: Ctrl-C, then `sudo tailscale serve --https=8443 off`.
# Never `tailscale serve reset`: the box's Ateam port is served the same way.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8082}"
HTTPS_PORT="${HTTPS_PORT:-8443}"
DNS="$(tailscale status --self --json |
	node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')"
URL="https://$DNS:$HTTPS_PORT"

# One port, one Metro: only one worktree can serve the phone at a time.
if ss -tlnH "sport = :$PORT" | grep -q .; then
	echo "Port $PORT is already in use (another worktree's Metro?):" >&2
	ss -tlnpH "sport = :$PORT" >&2
	echo "Stop it first, then run this again." >&2
	exit 1
fi

[ -d node_modules/expo-modules-core ] || npm install --no-workspaces --legacy-peer-deps

# Tailnet-only HTTPS in front of Metro (adds just this one entry).
tailscale serve --bg --https="$HTTPS_PORT" "http://127.0.0.1:$PORT" >/dev/null 2>&1 ||
	sudo tailscale serve --bg --https="$HTTPS_PORT" "http://127.0.0.1:$PORT" >/dev/null

echo
echo "  On the phone (on the tailnet): open Ateam Go Dev and enter $URL"
echo "  If Metro fails with ENOSPC: sudo sysctl fs.inotify.max_user_watches=524288"
echo

# EXPO_PACKAGER_PROXY_URL makes Metro hand out $URL links (manifest, bundle,
# hot-reload socket) instead of the box's private address.
export EXPO_PACKAGER_PROXY_URL="$URL"
export APP_VARIANT=development
exec npx expo start --dev-client --port "$PORT" "$@"
