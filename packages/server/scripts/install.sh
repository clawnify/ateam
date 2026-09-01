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
#   --service       also install a systemd unit so the daemon survives logout,
#                   reboot and an OOM kill (required for the iOS app, which cannot
#                   start a daemon on demand the way the desktop does over SSH).
#                   A SYSTEM unit where passwordless sudo is available, a `--user`
#                   one otherwise — only the former can stop the kernel from
#                   picking the daemon over the agents it supervises.
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

# The running engine daemon, identified by the one command line it always has:
# APP_DIR is fixed, and the systemd unit execs that same launcher.
DAEMON_PAT='ateam-app/cli\.js daemon'
# `|| true` earns its place: pgrep exits 1 when nothing matches, and under
# `pipefail` that becomes the substitution's status, which would trip `set -e` on
# the ordinary "no daemon running" case.
daemon_pid() { pgrep -f "$DAEMON_PAT" 2>/dev/null | head -1 || true; }

# One `system:hello` through the same relay a real client uses, so what this
# reports is what a client would see. `attach` is a persistent relay: it never
# self-exits after replying, so cap it and keep the first line.
handshake() {
	printf '{"t":"req","id":1,"method":"system:hello","args":[]}\n' |
		timeout 25 bash -lc 'ateam attach --stdio' 2>/dev/null | head -1 || true
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

step "[1/7] locate a Node ≥ 22"
NODE="$(find_node)"
if [ -z "$NODE" ]; then
	install_node22
	NODE="$(find_node)"
	[ -n "$NODE" ] || die "node 22 install failed"
fi
info "node: $NODE ($("$NODE" --version))"

# ------------------------------------------------------------- download ------

step "[2/7] fetch the server dist"
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

step "[3/7] install to $APP_DIR"
mkdir -p "$APP_DIR" "$BIN_DIR"
cp "$TMP/cli.js" "$TMP/daemon.js" "$TMP/package.json" "$APP_DIR/"

# ------------------------------------------------------------- natives -------

# npm ships with node; use the one beside the node we picked so the modules are
# built/downloaded for that exact ABI.
NPM="$(dirname "$NODE")/npm"
[ -x "$NPM" ] || NPM="$(command -v npm || true)"
[ -n "$NPM" ] || die "npm not found beside $NODE"

natives_load() { (cd "$APP_DIR" && "$NODE" -e 'require("better-sqlite3");require("node-pty")' >/dev/null 2>&1); }

step "[4/7] install native modules (prebuilt — no compiler needed)"
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

step "[5/7] install the 'ateam' launcher on the login PATH"
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

# ------------------------------------------------------------- restart ------

step "[6/7] stop the daemon still running the old dist"
# An upgrade that does not restart is not an upgrade. A running daemon holds its
# code in MEMORY, so overwriting cli.js above changes nothing about what it
# serves: the box keeps answering `system:hello` with the PREVIOUS protocol
# version, and every client goes on refusing it ("update the older side") however
# many times this installer is re-run, with the new dist sitting on disk beside it.
#
# Live agents are untouched. They belong to the PTY daemon (pty/daemon.ts), a
# separate detached process this never signals; the engine reattaches to it on
# start, and it only idle-exits once it has neither sessions nor clients. Clients
# see a blip and no more: the desktop reconnects over SSH, the phone reattaches.
#
# Stopped rather than restarted, because nothing needs to own the socket yet: the
# verify below spawns one from the NEW dist (which is what `ateam attach` does
# when none is live), and --service hands that to systemd right after.
OLD_PID="$(daemon_pid)"
if [ -n "$OLD_PID" ]; then
	pkill -f "$DAEMON_PAT" 2>/dev/null || true
	sleep 1
	info "stopped the old daemon (pid $OLD_PID); its agents keep running"
	# A systemd-managed daemon comes straight back on its own here (a signal counts
	# as failure, so `Restart=on-failure` fires), and that is fine: whatever starts
	# from now on runs the dist installed above. So this deliberately does NOT wait
	# for the pid to stay gone, which would race that restart and fail a healthy
	# box. The invariant that actually matters is asserted by the verify below.
else
	info "no daemon was running"
fi

# -------------------------------------------------------------- verify ------

step "[7/7] verify the handshake"
# Spawns a daemon from the dist just installed, so this proves the NEW code runs
# on this box's Node (where an ABI break surfaces) and prints the version every
# client will now see.
HELLO="$(handshake)"
case "$HELLO" in
*protocolVersion*) info "OK  $HELLO" ;;
*) die "handshake failed: ${HELLO:-<no reply>}" ;;
esac
# The one assertion that catches a silent no-op upgrade: the process answering
# must not be the one that predates this install. A handshake alone cannot tell
# the difference, which is why every stale box still reported a healthy install.
NEW_PID="$(daemon_pid)"
if [ -n "$OLD_PID" ] && [ "$NEW_PID" = "$OLD_PID" ]; then
	die "pid $OLD_PID survived, so this box is still serving the OLD dist: stop it and re-run"
fi

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
	if ! command -v systemctl >/dev/null; then
		die "no systemd on this box — start 'ateam daemon' from your own init instead"
	fi

	SYS_UNIT=/etc/systemd/system/ateam.service
	USER_UNIT="$HOME/.config/systemd/user/ateam.service"

	# A SYSTEM unit whenever we can escalate without a password, a user unit otherwise.
	# A user unit cannot protect this daemon, for three reasons that only bite under
	# memory pressure — exactly when you need it most:
	#   1. `user@.service` ships OOMScoreAdjust=100, which every user service inherits.
	#      That makes a ~40MB daemon a MORE attractive kernel OOM victim than the
	#      400MB agents it supervises (they sit at 0). Precisely backwards.
	#   2. A negative OOMScoreAdjust cannot fix that from a user unit: lowering the
	#      score needs CAP_SYS_RESOURCE, and systemd SILENTLY IGNORES the setting
	#      rather than failing — the unit starts and the value never lands, so the
	#      line reads as protection while doing nothing.
	#   3. A user unit dies with the systemd user manager. If that manager is itself
	#      OOM-killed, linger does NOT bring it back; only a new login does.
	# The desktop survives all three — it re-launches a daemon over SSH on demand.
	# THE PHONE CANNOT: the WebSocket only exists once a daemon is already running,
	# so for the iOS app this is the difference between a 3s restart and a box that
	# stays dark until someone opens a laptop.
	if sudo -n true 2>/dev/null; then
		SERVICE_SCOPE=system
		UNIT="$SYS_UNIT"
		SYSTEMCTL="sudo systemctl"
		step "install the system service"
	else
		SERVICE_SCOPE=user
		UNIT="$USER_UNIT"
		SYSTEMCTL="systemctl --user"
		step "install the user service"
		mkdir -p "$(dirname "$UNIT")"
	fi

	# Upgrading IS re-running this script, and a phone user who doesn't re-export
	# ATEAM_WS_ADDR would otherwise get a rewritten unit without it — silently
	# removing the phone's only way in, with the daemon still apparently healthy.
	# An explicit ATEAM_WS_ADDR always wins; otherwise inherit whichever unit has
	# one — including the OTHER scope's, so a user→system upgrade keeps the address.
	WS_ADDR="${ATEAM_WS_ADDR:-}"
	if [ -z "$WS_ADDR" ]; then
		for u in "$UNIT" "$SYS_UNIT" "$USER_UNIT"; do
			[ -f "$u" ] || continue
			WS_ADDR="$(sed -n 's/^Environment=ATEAM_WS_ADDR=//p' "$u" | tail -1)"
			if [ -n "$WS_ADDR" ]; then
				info "keeping ATEAM_WS_ADDR=$WS_ADDR from $u"
				break
			fi
		done
	fi

	emit_unit() {
		echo '[Unit]'
		echo 'Description=Ateam engine daemon'
		if [ "$SERVICE_SCOPE" = system ]; then
			# The WS listener binds the Tailscale IP, so that address must exist
			# before the bind. If it doesn't the daemon exits and the restart loop
			# below retries until Tailscale is up. (Meaningless in a user unit:
			# network-online.target lives in the SYSTEM manager, not the user one.)
			echo 'Wants=network-online.target'
			echo 'After=network-online.target tailscaled.service'
		fi
		# systemd gives up PERMANENTLY after 5 starts in 10s by default. A burst of
		# OOM kills exhausts that budget, and then nothing ever restarts the daemon
		# — the phone's only ingress stays down until a human logs in. Retry forever.
		echo 'StartLimitIntervalSec=0'
		echo ''
		echo '[Service]'
		# A LOGIN shell: agent CLIs are discovered with `which` against this
		# process's own PATH, and a bare unit PATH resolves none of them.
		echo "ExecStart=/bin/bash -lc 'exec ateam daemon'"
		if [ "$SERVICE_SCOPE" = system ]; then
			echo "User=$(id -un)"
			# NOT %h: in a system unit that expands to root's home, not User='s.
			echo "WorkingDirectory=$HOME"
			# What every distro already does for control-plane daemons (udevd -1000,
			# dbus -900, journald -250). This one owns the box's only phone ingress,
			# so the kernel should reap a 400MB agent before it. System scope only —
			# see the note above on why this line is worthless in a user unit.
			echo 'OOMScoreAdjust=-500'
		else
			echo 'WorkingDirectory=%h'
		fi
		# The PTY daemon is a DETACHED child holding every live agent session.
		# `detached` escapes the process group, NOT the cgroup — under the default
		# KillMode=control-group a restart would kill every running agent. Kill
		# only the main process so sessions survive, exactly as they do today.
		echo 'KillMode=process'
		# NOT `always`: `ateam daemon` exits 0 when another daemon already owns the
		# socket, and always-restart would turn that into a hot loop — one that
		# StartLimitIntervalSec=0 above would never brake. An OOM kill is a SIGKILL,
		# which counts as a failure, so self-healing is unaffected.
		echo 'Restart=on-failure'
		echo 'RestartSec=2'
		if [ -n "$WS_ADDR" ]; then echo "Environment=ATEAM_WS_ADDR=$WS_ADDR"; fi
		echo ''
		echo '[Install]'
		if [ "$SERVICE_SCOPE" = system ]; then
			echo 'WantedBy=multi-user.target'
		else
			echo 'WantedBy=default.target'
		fi
	}
	if [ "$SERVICE_SCOPE" = system ]; then
		emit_unit | sudo tee "$UNIT" >/dev/null
	else
		emit_unit >"$UNIT"
	fi
	info "wrote $UNIT"

	# Upgrading an older install: the user unit must stop owning the socket, or the
	# two race for it. Live agents are unaffected — they sit outside this unit's
	# cgroup and the PTY daemon holding them is never touched.
	if [ "$SERVICE_SCOPE" = system ] && [ -f "$USER_UNIT" ]; then
		if systemctl --user is-active --quiet ateam.service 2>/dev/null ||
			systemctl --user is-enabled --quiet ateam.service 2>/dev/null; then
			info "migrating the existing user service to a system service"
			systemctl --user disable --now ateam.service >/dev/null 2>&1 || true
		fi
	fi

	if [ "$SERVICE_SCOPE" = user ]; then
		# Keep the user manager alive with no login session, so the daemon comes back
		# after a reboot. Unprivileged: polkit's set-self-linger allows this for your
		# OWN user (set-user-linger, for someone else's, is the one needing admin).
		loginctl enable-linger 2>/dev/null || info "could not enable linger — the service won't start on boot"
	fi
	$SYSTEMCTL daemon-reload
	$SYSTEMCTL enable ateam.service >/dev/null 2>&1 || true

	# Take the socket back, then RESTART. Two reasons this is not `start`:
	#   1. `start` on an already-active unit does nothing, so an upgrade left the
	#      OLD process serving. That is the bug this installer shipped with, and it
	#      is why boxes stayed on an old protocol through repeated installs.
	#   2. `ateam daemon` deliberately bows out when a live daemon already owns the
	#      socket, so a service started around one (the verify step's, or one that
	#      an `ateam attach` spawned) exits 0 and the old code keeps answering.
	# Running agents survive both, for the reason spelled out at [6/7].
	if [ -n "$(daemon_pid)" ] && ! $SYSTEMCTL is-active --quiet ateam.service; then
		info "handing the out-of-systemd daemon over to the service"
		pkill -f "$DAEMON_PAT" 2>/dev/null || true
		sleep 1
	fi
	$SYSTEMCTL restart ateam.service

	# Prove the SERVICE is what answers now, and that it answers with the dist just
	# installed. `is-active` alone passed happily while a stale daemon held the
	# socket, which is precisely how the old protocol survived an "upgrade".
	SVC_PID=""
	for _ in 1 2 3 4 5 6 7 8 9 10; do
		sleep 1
		if $SYSTEMCTL is-active --quiet ateam.service; then
			SVC_PID="$(daemon_pid)"
			if [ -n "$SVC_PID" ]; then break; fi
		fi
	done
	if [ -z "$SVC_PID" ]; then die "service failed to start: $SYSTEMCTL status ateam"; fi
	if [ -n "$OLD_PID" ] && [ "$SVC_PID" = "$OLD_PID" ]; then
		die "pid $OLD_PID survived the restart, so the service is still the OLD dist"
	fi
	HELLO="$(handshake)"
	case "$HELLO" in
	*protocolVersion*) info "service active (pid $SVC_PID); starts on boot" ;;
	*) die "service is up but the handshake failed: ${HELLO:-<no reply>} ($SYSTEMCTL status ateam)" ;;
	esac
	info "serving: $HELLO"

	if [ "$SERVICE_SCOPE" = user ]; then
		info ""
		info "NOTE: installed as a USER service — no passwordless sudo on this box."
		info "The daemon is then a preferred kernel OOM victim and dies with the"
		info "systemd user manager, which only a new login restarts. The desktop"
		info "recovers on its own over SSH; the iOS app cannot. Grant sudo and"
		info "re-run this installer to upgrade it to a system service."
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
