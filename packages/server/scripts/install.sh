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
#   --service       also run the engine as a service, so it comes back after logout
#                   and reboot (required for the iOS app, which cannot start a daemon
#                   on demand the way the desktop does over SSH). Under systemd, a
#                   SYSTEM unit where passwordless sudo is available, a `--user` one
#                   otherwise: only the former can stop the kernel from picking the
#                   daemon over the agents it supervises. On a Sprite (no systemd), a
#                   Sprite service, which starts the engine when the Sprite boots.
#                   A re-run on a box that already has either keeps it.
#
# Env knobs:
#   ATEAM_VERSION   release tag to install (default: the latest release)
#   ATEAM_TARBALL   URL *or* local path to an ateam-server.tar.gz, bypassing the
#                   release lookup (dev/air-gapped installs)
#   ATEAM_WS_ADDR   <tailnet-ip>:<port> for the iOS app's WebSocket listener. Kept in
#                   ~/.ateam/ws-addr, which every engine on the box reads however it
#                   was started, and in the systemd unit by --service. On a re-run
#                   without it, the address the box already uses is kept.
#   ATEAM_WS_ADDR_DEFAULT  an address used only when neither ATEAM_WS_ADDR nor the
#                   box already has one. The desktop passes the box's tailnet IP this
#                   way, so an upgrade never replaces an address that works.
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
# The engine's data dir, resolved as cli.ts does; the phone's address is kept in it.
DATA_DIR="${ATEAM_DATA_DIR:-$HOME/.ateam}"
WS_ADDR_FILE="$DATA_DIR/ws-addr"
SYS_UNIT=/etc/systemd/system/ateam.service
USER_UNIT="$HOME/.config/systemd/user/ateam.service"
SPRITE_ENV="$(command -v sprite-env 2>/dev/null || true)"
if [ -z "$SPRITE_ENV" ] && [ -x /.sprite/bin/sprite-env ]; then SPRITE_ENV=/.sprite/bin/sprite-env; fi
# What supervises the engine here. systemd only when it actually is the init: a
# Sprite ships a systemctl binary with nothing behind it, so every systemctl call
# there fails. /run/systemd/system is the marker sd_booted() checks.
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null; then
	SVC_MGR=systemd
elif [ -n "$SPRITE_ENV" ]; then
	SVC_MGR=sprite
else
	SVC_MGR=none
fi
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
# The PTY daemon, which owns every live agent session (its children).
PTY_PAT='ateam-app/daemon\.js'
RPC_SOCK="${ATEAM_RPC_SOCK:-$HOME/.ateam/rpc.sock}"
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

# ------------------------------------------------------- phone address ------

# Upgrading IS re-running this script, and a phone user who doesn't re-export
# ATEAM_WS_ADDR must not lose the phone's only way in. An explicit ATEAM_WS_ADDR
# wins; else whatever the box already serves the phone on: a systemd unit of either
# scope (so a user to system upgrade keeps it), the Sprite's service, the address
# file. Only then the caller's ATEAM_WS_ADDR_DEFAULT.
#
# Written to the file BEFORE the old daemon stops, so the one the verify step
# starts, and any later `ateam attach` spawn, serves the phone too. An address kept
# only in a service's environment was lost by every daemon started any other way.
WS_ADDR="${ATEAM_WS_ADDR:-}"
WS_FROM="ATEAM_WS_ADDR"
if [ -z "$WS_ADDR" ]; then
	for u in "$SYS_UNIT" "$USER_UNIT"; do
		[ -f "$u" ] || continue
		WS_ADDR="$(sed -n 's/^Environment=ATEAM_WS_ADDR=//p' "$u" | tail -1)"
		if [ -n "$WS_ADDR" ]; then
			WS_FROM="$u"
			break
		fi
	done
fi
if [ -z "$WS_ADDR" ] && [ "$SVC_MGR" = sprite ]; then
	WS_ADDR="$("$SPRITE_ENV" services get ateam 2>/dev/null | "$NODE" -e '
		let s = "";
		process.stdin.on("data", (d) => (s += d)).on("end", () => {
			try { process.stdout.write(JSON.parse(s).env?.ATEAM_WS_ADDR ?? ""); } catch {}
		});' || true)"
	if [ -n "$WS_ADDR" ]; then WS_FROM="the Sprite's ateam service"; fi
fi
if [ -z "$WS_ADDR" ] && [ -f "$WS_ADDR_FILE" ]; then
	WS_ADDR="$(head -1 "$WS_ADDR_FILE" | tr -d '[:space:]')"
	if [ -n "$WS_ADDR" ]; then WS_FROM="$WS_ADDR_FILE"; fi
fi
if [ -z "$WS_ADDR" ] && [ -n "${ATEAM_WS_ADDR_DEFAULT:-}" ]; then
	WS_ADDR="$ATEAM_WS_ADDR_DEFAULT"
	WS_FROM="ATEAM_WS_ADDR_DEFAULT"
fi
if [ -n "$WS_ADDR" ]; then
	mkdir -p "$DATA_DIR"
	printf '%s\n' "$WS_ADDR" >"$WS_ADDR_FILE"
	info "phone listener: $WS_ADDR (from $WS_FROM), kept in $WS_ADDR_FILE"
fi

# ------------------------------------------------------ Sprite service ------

# On a Sprite the service must own the engine and must never be restarted.
# Measured on a Sprite: sprite-env restarts a service whose process exits (at once
# after exit 0, with backoff otherwise), and stopping, restarting or deleting a
# service, or restarting it after an exit, kills every process it started, setsid
# or not. The PTY daemon holding every live agent is one of those. So the service
# runs a keeper loop that never exits: when the engine stops (this upgrade, or a
# crash) the loop starts it again from the installed dist, and the PTY daemon is
# untouched. A quick exit means another engine owns the socket, so it waits longer.
# An older service that execs the engine directly is moved to the loop, but only
# while no agent runs, since moving it means deleting it. No commas: sprite-env
# splits --args on them.
KEEPER=': ateam-keeper; while :; do s=$SECONDS; ateam daemon; if [ $((SECONDS - s)) -lt 10 ]; then sleep 30; else sleep 1; fi; done'
SPRITE_PLAN=""
# "<exists> <is the keeper> <pid sprite-env has for it, or ->", each 0/1.
sprite_service() {
	"$SPRITE_ENV" services get ateam 2>/dev/null | "$NODE" -e '
		let s = "";
		process.stdin.on("data", (d) => (s += d)).on("end", () => {
			try {
				const j = JSON.parse(s);
				const keeper = (j.args || []).join(" ").includes("ateam-keeper");
				process.stdout.write(`1 ${keeper ? 1 : 0} ${j.state?.pid ?? "-"}`);
			} catch {
				process.stdout.write("0 0 -");
			}
		});' || echo "0 0 -"
}
if [ "$SVC_MGR" = sprite ]; then
	read -r SVC_EXISTS SVC_KEEPER SVC_PID <<<"$(sprite_service)"
	if [ "$WANT_SERVICE" = 0 ] && [ "$SVC_EXISTS" = 1 ]; then WANT_SERVICE=1; fi
	# A live agent is a child of a PTY daemon; check every one there is.
	SESSIONS=""
	for p in $(pgrep -f "$PTY_PAT" 2>/dev/null || true); do
		if [ -n "$(pgrep -P "$p" 2>/dev/null | head -1 || true)" ]; then SESSIONS=1; fi
	done
	if [ "$SVC_EXISTS" = 1 ] && [ "$SVC_KEEPER" = 1 ]; then
		SPRITE_PLAN=keeper
	elif [ "$SVC_EXISTS" = 1 ] && [ -z "$SESSIONS" ]; then
		SPRITE_PLAN=migrate
	elif [ "$SVC_EXISTS" = 1 ] && [ "$SVC_PID" != - ] && kill -0 "$SVC_PID" 2>/dev/null; then
		die "agents are running under this Sprite's ateam service, and restarting its engine would end them. Re-run this installer when no agent is running."
	elif [ "$SVC_EXISTS" = 1 ]; then
		# sprite-env lost track of the service's process (its pid is gone), so stopping
		# the engine below triggers no restart and the agents keep running.
		SPRITE_PLAN=outside
	elif [ "$WANT_SERVICE" = 1 ]; then
		SPRITE_PLAN=create
	fi
fi

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
# when none is live), and the service step hands that to systemd right after. A
# Sprite's service is deliberately left alone; the service step says why.
OLD_PID="$(daemon_pid)"
if [ -n "$OLD_PID" ]; then
	pkill -f "$DAEMON_PAT" 2>/dev/null || true
	sleep 1
	info "stopped the old daemon (pid $OLD_PID); its agents keep running"
	# Under systemd this does NOT come back on its own: SIGTERM is one of the signals
	# systemd counts as a clean exit, so `Restart=on-failure` leaves the unit stopped
	# until the service step below restarts it. A run that dies in between leaves the
	# box served by whatever engine starts next (the verify step's, or the next
	# `ateam attach`), outside systemd but still on the phone's address, from the
	# file written above. Whatever starts from here on runs the dist installed
	# above; the verify below asserts it.
else
	info "no daemon was running"
fi

if [ "$SPRITE_PLAN" = migrate ]; then
	step "move the Sprite service to the keeper loop (no agent is running)"
	"$SPRITE_ENV" services delete ateam >/dev/null 2>&1 || true
	sleep 1
fi
if [ "$SPRITE_PLAN" = migrate ] || [ "$SPRITE_PLAN" = create ]; then
	"$SPRITE_ENV" services create ateam --cmd bash --args "-lc,$KEEPER" --no-stream >/dev/null
	info "the ateam service now keeps the engine running, and starts it when the Sprite boots"
fi
# Under the keeper the new engine comes from the loop. Wait for it to own the
# socket, or the handshake's `ateam attach` would spawn a second one outside it.
if [ "$SPRITE_PLAN" = keeper ] || [ "$SPRITE_PLAN" = migrate ] || [ "$SPRITE_PLAN" = create ]; then
	KEPT=""
	for _ in $(seq 1 40); do
		if ss -lx 2>/dev/null | grep -F "$RPC_SOCK" >/dev/null && [ -n "$(daemon_pid)" ]; then
			KEPT=1
			break
		fi
		sleep 1
	done
	if [ -z "$KEPT" ]; then die "the Sprite's keeper loop didn't bring the engine up: sprite-env services get ateam"; fi
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
# one back after a reboot. A box that already runs the engine as a service keeps
# it on a plain re-run, instead of being left on the verify step's daemon outside
# it (how PR #283 found boxes).
if [ "$WANT_SERVICE" = 0 ] && [ "$SVC_MGR" = systemd ] && { [ -f "$SYS_UNIT" ] || [ -f "$USER_UNIT" ]; }; then
	WANT_SERVICE=1
fi

if [ "$SVC_MGR" = sprite ]; then
	# Settled before the old daemon stopped: see "Sprite service" above.
	if [ "$SPRITE_PLAN" = outside ]; then
		info "NOTE: this Sprite's ateam service predates the keeper loop, and agents are"
		info "running, so it was left alone. Re-run this installer when no agent is running"
		info "to move it; until then an engine crash restarts the service and ends them."
	fi
elif [ "$WANT_SERVICE" = 1 ]; then
	if [ "$SVC_MGR" != systemd ]; then
		die "no systemd (and not a Sprite) on this box: start 'ateam daemon' from your own init instead"
	fi

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

	# WS_ADDR was resolved before the old daemon stopped (see "phone address"), so
	# the unit keeps carrying the address the box already used.

	emit_unit() {
		echo '[Unit]'
		echo 'Description=Ateam engine daemon'
		if [ "$SERVICE_SCOPE" = system ]; then
			# The WS listener binds the Tailscale IP, so that address must exist
			# before the bind. If it doesn't yet, the listener retries in the
			# background until it does. (Meaningless in a user unit:
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

# ----------------------------------------------------------- phone port -----

# Checked rather than assumed: a daemon that came up without the address answered
# every handshake above and still left the phone dark. A warning, not a failure:
# the listener keeps retrying until Tailscale has the address, so a box whose
# tailnet is still coming up gets there on its own. grep without -q reads all of
# its input, so `pipefail` can't turn a match into a SIGPIPE'd failure.
if [ -n "$WS_ADDR" ] && command -v ss >/dev/null; then
	LISTENING=""
	for _ in 1 2 3 4 5 6 7 8 9 10; do
		if ss -ltn 2>/dev/null | awk 'NR > 1 { print $4 }' | grep -xF "$WS_ADDR" >/dev/null; then
			LISTENING=1
			break
		fi
		sleep 1
	done
	if [ -n "$LISTENING" ]; then
		info "phone listener up on $WS_ADDR"
	else
		info "WARNING: nothing listens on $WS_ADDR yet, so the phone can't connect (is Tailscale up?)"
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
