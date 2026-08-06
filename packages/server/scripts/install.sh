#!/usr/bin/env bash
# Install the `ateam` server on a Linux box, straight from a GitHub Release:
#
#   curl -fsSL https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh | bash
#
# Run it AS THE USER that will own the agents (not root) — everything lands under
# that user's home and no step needs sudo. It is idempotent: re-running upgrades
# the dist in place. Files are only ever created or overwritten, never removed.
#
# Options:
#   --service       also install a `systemd --user` unit so the daemon survives
#                   logout and reboot (required for the iOS app, which cannot
#                   start a daemon on demand the way the desktop does over SSH)
#
# Env knobs:
#   ATEAM_VERSION   release tag to install (default: the latest release)
#   ATEAM_TARBALL   URL *or* local path to an ateam-server.tar.gz, bypassing the
#                   release lookup (dev/air-gapped installs)
#   ATEAM_WS_ADDR   <tailnet-ip>:<port> for the iOS app's WebSocket listener,
#                   baked into the unit by --service. On a re-run without it, an
#                   address already in the unit is kept rather than dropped.
#
# Node: the dist externalizes two native modules — better-sqlite3 and the
# prebuilt node-pty fork — so the box needs a Node whose ABI both ship binaries
# for, and NO compiler. Node 22 is the version this is proven on; if the box has
# nothing suitable, nvm + node 22 are installed into the user's home.
set -euo pipefail

REPO="clawnify/ateam"
APP_DIR="$HOME/ateam-app"
BIN_DIR="$HOME/.local/bin"
WANT_SERVICE=0
if [ "${1:-}" = "--service" ]; then WANT_SERVICE=1; fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

step() { printf '\n==> %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
die() {
	printf '\n!! %s\n' "$1" >&2
	exit 1
}

if [ "$(id -u)" = 0 ]; then die "run this as the user that will own the agents, not as root"; fi
command -v curl >/dev/null || die "curl is required"
command -v tar >/dev/null || die "tar is required"

# ---------------------------------------------------------------- node -------

# Print the major version of a node binary, or nothing if it can't run.
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true; }

# Echo the best node on the box, preferring an existing v22 (the ABI both native
# modules are proven against) over a newer one.
find_node() {
	local best="" cand major
	for cand in "$HOME"/.nvm/versions/node/v22*/bin/node "$(command -v node || true)" \
		"$HOME"/.nvm/versions/node/v*/bin/node; do
		[ -x "${cand:-}" ] || continue
		major="$(node_major "$cand")"
		[ -n "$major" ] && [ "$major" -ge 22 ] 2>/dev/null || continue
		if [ "$major" = 22 ]; then
			echo "$cand"
			return 0
		fi
		[ -n "$best" ] || best="$cand"
	done
	echo "$best"
}

install_node22() {
	step "installing node 22 (nvm, into \$HOME — no sudo, no system packages)"
	curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash >/dev/null
	# nvm's shell functions are not written for `set -eu`; relax around them only.
	set +eu
	# shellcheck disable=SC1091
	. "$HOME/.nvm/nvm.sh"
	nvm install 22 >/dev/null
	nvm alias default 22 >/dev/null
	set -eu
}

step "[1/6] locate a Node ≥ 22"
NODE="$(find_node)"
if [ -z "$NODE" ]; then
	install_node22
	NODE="$(find_node)"
	[ -n "$NODE" ] || die "node 22 install failed"
fi
info "node: $NODE ($("$NODE" --version))"

# ------------------------------------------------------------- download ------

step "[2/6] fetch the server dist"
TARBALL="$TMP/ateam-server.tar.gz"
if [ -n "${ATEAM_TARBALL:-}" ] && [ -f "$ATEAM_TARBALL" ]; then
	info "source: $ATEAM_TARBALL (local)"
	cp "$ATEAM_TARBALL" "$TARBALL"
else
	if [ -n "${ATEAM_TARBALL:-}" ]; then
		URL="$ATEAM_TARBALL"
	elif [ -n "${ATEAM_VERSION:-}" ]; then
		URL="https://github.com/$REPO/releases/download/$ATEAM_VERSION/ateam-server.tar.gz"
	else
		URL="https://github.com/$REPO/releases/latest/download/ateam-server.tar.gz"
	fi
	info "source: $URL"
	curl -fsSL -o "$TARBALL" "$URL" ||
		die "download failed — no ateam-server.tar.gz on that release. See https://github.com/$REPO/releases"
fi

tar -xzf "$TARBALL" -C "$TMP"
# Only clobber a working install once we know the payload is intact.
for f in cli.js daemon.js package.json; do
	[ -f "$TMP/$f" ] || die "malformed tarball: missing $f"
done

step "[3/6] install to $APP_DIR"
mkdir -p "$APP_DIR" "$BIN_DIR"
cp "$TMP/cli.js" "$TMP/daemon.js" "$TMP/package.json" "$APP_DIR/"

# ------------------------------------------------------------- natives -------

# npm ships with node; use the one beside the node we picked so the modules are
# built/downloaded for that exact ABI.
NPM="$(dirname "$NODE")/npm"
[ -x "$NPM" ] || NPM="$(command -v npm || true)"
[ -n "$NPM" ] || die "npm not found beside $NODE"

natives_load() { (cd "$APP_DIR" && "$NODE" -e 'require("better-sqlite3");require("node-pty")' >/dev/null 2>&1); }

step "[4/6] install native modules (prebuilt — no compiler needed)"
(cd "$APP_DIR" && PATH="$(dirname "$NODE"):$PATH" "$NPM" install --omit=dev --no-audit --no-fund >/dev/null 2>&1) ||
	die "npm install failed in $APP_DIR"

if ! natives_load; then
	# The known failure: a Node newer than the prebuilds cover (node-pty has no
	# binary for it). Fall back to 22, which both modules ship for.
	info "native modules don't load under $("$NODE" --version) — falling back to node 22"
	install_node22
	NODE="$(find_node)"
	NPM="$(dirname "$NODE")/npm"
	(cd "$APP_DIR" && PATH="$(dirname "$NODE"):$PATH" "$NPM" install --omit=dev --no-audit --no-fund >/dev/null 2>&1)
	natives_load || die "native modules still fail to load under $("$NODE" --version)"
fi
info "better-sqlite3 + node-pty load OK"

# -------------------------------------------------------------- launcher ----

step "[5/6] install the 'ateam' launcher on the login PATH"
# Node is pinned by absolute path: the launcher must use the SAME runtime the
# natives were installed for, whatever a login shell's PATH happens to resolve.
printf '#!/bin/sh\nexec %s "%s/cli.js" "$@"\n' "$NODE" "$APP_DIR" >"$BIN_DIR/ateam"
chmod +x "$BIN_DIR/ateam"

# Clients connect with `bash -lc 'exec ateam attach --stdio'`, so what matters is
# the LOGIN shell's PATH. Bash reads only the first of these that exists.
if ! bash -lc 'command -v ateam' >/dev/null 2>&1; then
	PROFILE="$HOME/.profile"
	for f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
		if [ -f "$f" ]; then
			PROFILE="$f"
			break
		fi
	done
	{
		echo ''
		echo '# added by the ateam installer'
		echo 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH" ;; esac'
	} >>"$PROFILE"
	info "added ~/.local/bin to the login PATH via $PROFILE"
	bash -lc 'command -v ateam' >/dev/null 2>&1 || die "ateam still not on the login PATH ($PROFILE)"
fi
info "login shell resolves: $(bash -lc 'command -v ateam')"

# -------------------------------------------------------------- verify ------

step "[6/6] verify the handshake"
# `attach` is a persistent relay — it never self-exits after replying, so cap it
# and keep the first line. A real client holds the connection open instead.
HELLO="$(printf '{"t":"req","id":1,"method":"system:hello","args":[]}\n' |
	timeout 25 bash -lc 'ateam attach --stdio' 2>/dev/null | head -1 || true)"
case "$HELLO" in
*protocolVersion*) info "OK  $HELLO" ;;
*) die "handshake failed: ${HELLO:-<no reply>}" ;;
esac

# ------------------------------------------------------------------ gh ------

# The GitHub CLI, so the box can clone/push your repos AND we can derive your git
# identity from your account (below). Installed as a user-local binary — NO sudo:
# some boxes have no passwordless sudo, and the rest of this script is sudo-free.
# Non-fatal: a box with no gh can still run non-GitHub work.
if ! bash -lc 'command -v gh' >/dev/null 2>&1; then
	step "install the GitHub CLI (gh)"
	GH_ARCH="$(uname -m)"
	case "$GH_ARCH" in x86_64) GH_ARCH=amd64 ;; aarch64 | arm64) GH_ARCH=arm64 ;; esac
	GH_TAG="$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | grep -m1 '"tag_name"' | cut -d'"' -f4)"
	if [ -n "$GH_TAG" ]; then
		GH_TMP="$(mktemp -d)"
		if curl -fsSL "https://github.com/cli/cli/releases/download/${GH_TAG}/gh_${GH_TAG#v}_linux_${GH_ARCH}.tar.gz" |
			tar -xz -C "$GH_TMP" 2>/dev/null; then
			cp "$GH_TMP"/gh_*/bin/gh "$BIN_DIR/gh" && chmod +x "$BIN_DIR/gh"
			info "gh installed ($("$BIN_DIR/gh" --version | head -1))"
		else
			info "could not download gh — clone/push will need it installed later"
		fi
		rm -rf "$GH_TMP"
	fi
fi

# -------------------------------------------------------------- service ----

# Opt-in (`install.sh --service`). Without it the daemon is started on demand by
# the first `ateam attach`, which is enough for the desktop but NOT for the phone:
# the WebSocket only exists once a daemon is already running, and nothing brings
# one back after a reboot.
if [ "$WANT_SERVICE" = 1 ]; then
	step "install the user service"
	if ! command -v systemctl >/dev/null; then
		die "no systemd on this box — start 'ateam daemon' from your own init instead"
	fi
	UNIT_DIR="$HOME/.config/systemd/user"
	UNIT="$UNIT_DIR/ateam.service"
	mkdir -p "$UNIT_DIR"

	# Upgrading IS re-running this script, and a phone user who doesn't re-export
	# ATEAM_WS_ADDR would otherwise get a rewritten unit without it — silently
	# removing the phone's only way in, with the daemon still apparently healthy.
	# An explicit ATEAM_WS_ADDR always wins; otherwise inherit what's already there.
	WS_ADDR="${ATEAM_WS_ADDR:-}"
	if [ -z "$WS_ADDR" ] && [ -f "$UNIT" ]; then
		WS_ADDR="$(sed -n 's/^Environment=ATEAM_WS_ADDR=//p' "$UNIT" | tail -1)"
		if [ -n "$WS_ADDR" ]; then info "keeping ATEAM_WS_ADDR=$WS_ADDR from the existing unit"; fi
	fi
	{
		echo '[Unit]'
		echo 'Description=Ateam engine daemon'
		echo ''
		echo '[Service]'
		# A LOGIN shell: agent CLIs are discovered with `which` against this
		# process's own PATH, and a bare unit PATH resolves none of them.
		echo "ExecStart=/bin/bash -lc 'exec ateam daemon'"
		echo 'WorkingDirectory=%h'
		# The PTY daemon is a DETACHED child holding every live agent session.
		# `detached` escapes the process group, NOT the cgroup — under the default
		# KillMode=control-group a restart would kill every running agent. Kill
		# only the main process so sessions survive, exactly as they do today.
		echo 'KillMode=process'
		# NOT `always`: `ateam daemon` exits 0 when another daemon already owns the
		# socket, and always-restart would turn that into a hot loop.
		echo 'Restart=on-failure'
		echo 'RestartSec=2'
		if [ -n "$WS_ADDR" ]; then echo "Environment=ATEAM_WS_ADDR=$WS_ADDR"; fi
		echo ''
		echo '[Install]'
		echo 'WantedBy=default.target'
	} >"$UNIT"
	info "wrote $UNIT"

	# Keep the user manager alive with no login session, so the daemon comes back
	# after a reboot. Unprivileged: polkit's set-self-linger allows this for your
	# OWN user (set-user-linger, for someone else's, is the one needing admin).
	loginctl enable-linger 2>/dev/null || info "could not enable linger — the service won't start on boot"
	systemctl --user daemon-reload
	systemctl --user enable ateam.service >/dev/null 2>&1 || true

	# Never kill a daemon out from under running agents. If one is already up
	# outside systemd, hand over deliberately rather than silently.
	if [ -S "$HOME/.ateam/rpc.sock" ] && ! systemctl --user is-active --quiet ateam.service; then
		info "a daemon is already running outside systemd — enabled for next boot."
		info "to hand it over now (agents keep running; the PTY daemon is untouched):"
		info "     pkill -f 'ateam-app/cli.js daemon' && systemctl --user start ateam"
	else
		systemctl --user start ateam.service
		sleep 2
		systemctl --user is-active --quiet ateam.service &&
			info "service active; starts on boot" ||
			die "service failed to start — systemctl --user status ateam"
	fi
fi

# ------------------------------------------------------------ readiness -----

# Everything below needs a human (a name, a browser login), so it is reported,
# never guessed at.
step "readiness"
have() { bash -lc "command -v $1" >/dev/null 2>&1; }
mark() { [ "$1" = ok ] && printf '    [ok] %s\n' "$2" || printf '    [--] %s\n' "$2"; }

# gh auth does NOT set your commit identity, so derive it from the authenticated
# GitHub account — one `gh auth login` then covers BOTH clone/push access and the
# commit author. Runs on any re-run after you've signed in.
GH_BIN="$(bash -lc 'command -v gh' 2>/dev/null || true)"
if { [ -z "$(git config --global user.name || true)" ] || [ -z "$(git config --global user.email || true)" ]; } &&
	[ -n "$GH_BIN" ] && "$GH_BIN" auth status >/dev/null 2>&1; then
	GH_NAME="$("$GH_BIN" api user -q '.name // .login' 2>/dev/null || true)"
	GH_EMAIL="$("$GH_BIN" api user -q '"\(.id)+\(.login)@users.noreply.github.com"' 2>/dev/null || true)"
	[ -n "$GH_NAME" ] && git config --global user.name "$GH_NAME"
	[ -n "$GH_EMAIL" ] && git config --global user.email "$GH_EMAIL"
fi
if [ -n "$(git config --global user.name || true)" ] && [ -n "$(git config --global user.email || true)" ]; then
	mark ok "git identity ($(git config --global user.name) <$(git config --global user.email)>)"
else
	mark no 'git identity — set automatically once you `gh auth login`, or by hand:'
	info '     git config --global user.name "you"; git config --global user.email "you@example.com"'
fi

if [ -n "$GH_BIN" ] && "$GH_BIN" auth status >/dev/null 2>&1; then
	mark ok "GitHub signed in ($("$GH_BIN" api user -q .login 2>/dev/null))"
else
	mark no 'GitHub — sign in so the box can clone your repos:  gh auth login'
fi

AGENTS=""
for a in claude codex; do
	if have "$a"; then AGENTS="$AGENTS $a"; fi
done
if [ -n "$AGENTS" ]; then
	mark ok "agent CLIs on the login PATH:$AGENTS"
else
	mark no 'no agent CLI found — install at least one (e.g. claude) and log into it'
fi

if command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
	mark ok "tailscale up ($(tailscale ip -4 2>/dev/null | head -1))"
else
	mark no 'tailscale — how the desktop/phone reach this box privately'
fi

cat <<EOF

Installed. From your Mac, add this box to ~/.ssh/config, then pick it in Ateam's
connection switcher. Clients connect with:

    bash -lc 'exec ateam attach --stdio'
EOF
