#!/usr/bin/env bash
# Give a box's agents a real Chrome, and give you a window onto it:
#
#   curl -fsSL https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install-browser.sh | bash
#
# What lands on the box:
#   - a virtual desktop: Xvfb on :99 plus Openbox, so Chrome runs headed (real
#     rendering, real logins) on a machine with no screen
#   - Google Chrome on that desktop, one profile shared by every agent, so a site
#     you log into once stays logged in for all of them
#   - TaskWindow (github.com/clawnify/TaskWindow): its extension is force-installed
#     by Chrome policy and pairs with its daemon by itself, and the daemon exposes
#     the browser to agents as an MCP server on 127.0.0.1:9377. Registered with
#     Claude Code for this user when `claude` is on the box.
#   - noVNC, so you can watch the desktop and take over (a login, a 2FA prompt, a
#     CAPTCHA): in the desktop app's Browser panel, or from any browser on your
#     tailnet
#
# Run it AS THE USER that owns the agents, the same one install.sh ran as. Unlike
# install.sh it needs sudo once (apt packages and Chrome's policy directory). It
# is idempotent: a re-run installs what is missing and leaves running services be,
# so it never closes a browser an agent is using.
#
# Env knobs:
#   ATEAM_BROWSER_VIEW_ADDR  <ip>:<port> noVNC ALSO listens on, beside
#                     127.0.0.1:6080 (which the desktop app's ssh forward reaches).
#                     Default: the box's tailnet IP (from ~/.ateam/ws-addr, else
#                     `tailscale ip`, when an interface owns it) on port 6080, or
#                     nothing with no tailnet. The VNC password is the second lock,
#                     not the first: never set this to a public address.
#   TASKWINDOW_VERSION       the TaskWindow release to pin (default below)
set -euo pipefail

TASKWINDOW_VERSION="${TASKWINDOW_VERSION:-0.2.13}"
# The Chrome Web Store id of TaskWindow; the store build pairs with the daemon by
# this origin, so nobody has to click through a pairing.
TASKWINDOW_EXTENSION_ID="adbfpkbjndcpjihceobeegkokblgifpe"
TASKWINDOW_PORT=9377
CDP_PORT=9222
DISPLAY_NUM=":99"
DATA_DIR="${ATEAM_DATA_DIR:-$HOME/.ateam}"
BROWSER_DIR="$DATA_DIR/browser"
PROFILE_DIR="$BROWSER_DIR/profile"
VNC_PASS_FILE="$BROWSER_DIR/vnc-password"
VNC_AUTH_FILE="$BROWSER_DIR/vnc-passwd"
TW_PREFIX="$BROWSER_DIR/taskwindow"
TW_ENTRY="$TW_PREFIX/node_modules/taskwindow/src/index.js"
BIN_DIR="$HOME/.local/bin"
CHROME_LAUNCHER="$BIN_DIR/ateam-chrome"
XVFB_LAUNCHER="$BIN_DIR/ateam-xvfb"
SERVICES="ateam-xvfb ateam-openbox ateam-chrome ateam-x11vnc ateam-novnc ateam-taskwindow"

SPRITE_ENV="$(command -v sprite-env 2>/dev/null || true)"
if [ -z "$SPRITE_ENV" ] && [ -x /.sprite/bin/sprite-env ]; then SPRITE_ENV=/.sprite/bin/sprite-env; fi
# Same test as install.sh: a Sprite ships a systemctl with nothing behind it.
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null; then
	SVC_MGR=systemd
elif [ -n "$SPRITE_ENV" ]; then
	SVC_MGR=sprite
else
	SVC_MGR=none
fi

step() { printf '\n==> %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
die() {
	printf '\n!! %s\n' "$1" >&2
	exit 1
}

if [ "$(id -u)" = 0 ]; then die "run this as the user that owns the agents, not as root"; fi
[ "$SVC_MGR" != none ] || die "no systemd (and not a Sprite) on this box: nothing to keep the browser running"
command -v apt-get >/dev/null || die "this installer needs a Debian/Ubuntu box (apt-get)"
sudo -n true 2>/dev/null || die "this needs passwordless sudo once, for apt and Chrome's policy directory"
command -v curl >/dev/null || die "curl is required"

# The node the engine runs on, which install.sh pinned in its launcher and whose
# npm it already used; TaskWindow only needs >= 18. The login PATH's node can be
# a distro build without npm (a Sprite's /usr/bin/node), so it is only the fallback.
NODE="$(sed -n 's/^exec \([^ ]*\) .*/\1/p' "$BIN_DIR/ateam" 2>/dev/null | head -1)"
[ -x "$NODE" ] || NODE="$(bash -lc 'command -v node' 2>/dev/null || true)"
[ -n "$NODE" ] || die "no node on the login PATH: run install.sh first"
NODE="$(readlink -f "$NODE")"
NPM="$(dirname "$NODE")/npm"
[ -x "$NPM" ] || NPM="$(bash -lc 'command -v npm' 2>/dev/null || true)"
[ -n "$NPM" ] || die "npm not found beside $NODE"

# ----------------------------------------------------------- packages ------

step "[1/6] install Chrome and the virtual desktop"
case "$(dpkg --print-architecture)" in
amd64) CHROME_DEB=google-chrome-stable_current_amd64.deb ;;
*) die "Google Chrome ships for amd64 only, and this box is $(dpkg --print-architecture)" ;;
esac
PKGS="xvfb openbox x11vnc novnc websockify fonts-noto-color-emoji"
if ! command -v google-chrome >/dev/null; then
	TMP="$(mktemp -d)"
	trap 'rm -rf "$TMP"' EXIT
	curl -fsSL -o "$TMP/chrome.deb" "https://dl.google.com/linux/direct/$CHROME_DEB"
	# apt wants a path it can read as _apt; a user's mktemp dir isn't one.
	chmod 755 "$TMP"
	PKGS="$PKGS $TMP/chrome.deb"
fi
# shellcheck disable=SC2086
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $PKGS >/dev/null ||
	die "apt-get install failed: re-run with the packages listed above to see why"
info "$(google-chrome --version)"

# ------------------------------------------------------------- config ------

step "[2/6] configure Chrome, the desktop and the VNC password"
# Force-install from the store by policy. Branded Chrome 137+ ignores
# --load-extension, but still honours ExtensionInstallForcelist.
sudo mkdir -p /etc/opt/chrome/policies/managed
printf '{"ExtensionInstallForcelist":["%s;https://clients2.google.com/service/update2/crx"]}\n' \
	"$TASKWINDOW_EXTENSION_ID" | sudo tee /etc/opt/chrome/policies/managed/taskwindow.json >/dev/null

# Focus follows the mouse, so a click through noVNC always reaches Chrome.
mkdir -p "$HOME/.config/openbox"
if [ ! -f "$HOME/.config/openbox/rc.xml" ]; then
	sed -e 's|<followMouse>no</followMouse>|<followMouse>yes</followMouse>|' \
		-e 's|<raiseOnFocus>no</raiseOnFocus>|<raiseOnFocus>yes</raiseOnFocus>|' \
		-e 's|<focusDelay>200</focusDelay>|<focusDelay>0</focusDelay>|' \
		/etc/xdg/openbox/rc.xml >"$HOME/.config/openbox/rc.xml"
fi

mkdir -p "$BROWSER_DIR" "$PROFILE_DIR" "$BIN_DIR"
chmod 700 "$BROWSER_DIR"
if [ ! -s "$VNC_PASS_FILE" ]; then
	# VNC passwords stop at 8 characters, so more would only look stronger.
	(umask 077 && head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 8 >"$VNC_PASS_FILE")
fi
x11vnc -storepasswd "$(cat "$VNC_PASS_FILE")" "$VNC_AUTH_FILE" >/dev/null 2>&1
chmod 600 "$VNC_AUTH_FILE"

# --no-sandbox: Chrome's sandbox needs unprivileged user namespaces, which
# containers (a Sprite) and Ubuntu's AppArmor defaults withhold. The marked-clean
# exit and the cleared Singleton locks let Chrome come back after a kill without
# a "restore pages?" bubble or a "profile in use" refusal.
cat >"$CHROME_LAUNCHER" <<EOF
#!/bin/bash
# Written by Ateam's install-browser.sh: the box's one Chrome, with CDP on loopback.
P="$PROFILE_DIR"
sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/' "\$P/Default/Preferences" 2>/dev/null
rm -f "\$P"/Singleton*
exec /usr/bin/google-chrome --no-sandbox --disable-gpu --remote-debugging-port=$CDP_PORT \\
	--user-data-dir="\$P" --no-first-run --disable-session-crashed-bubble --lang=en-US \\
	--start-maximized --window-size=1280,720 about:blank
EOF
chmod +x "$CHROME_LAUNCHER"

# Xvfb refuses a display whose lock file outlived its server, and a Sprite keeps
# /tmp across a restart, so one stale lock left every restart failing. The lock is
# cleared only when the pid in it isn't a running Xvfb.
D="${DISPLAY_NUM#:}"
cat >"$XVFB_LAUNCHER" <<EOF
#!/bin/bash
# Written by Ateam's install-browser.sh: the virtual display Chrome runs on.
L=/tmp/.X$D-lock
pid="\$(tr -d ' ' 2>/dev/null <"\$L")"
if [ -n "\$pid" ] && [ "\$(cat /proc/\$pid/comm 2>/dev/null)" != Xvfb ]; then
	rm -f "\$L" /tmp/.X11-unix/X$D
fi
exec /usr/bin/Xvfb $DISPLAY_NUM -screen 0 1280x720x24 -nolisten tcp
EOF
chmod +x "$XVFB_LAUNCHER"

# ---------------------------------------------------------- taskwindow -----

step "[3/6] install TaskWindow $TASKWINDOW_VERSION"
# Into its own prefix: no sudo, no global npm, and a pinned version per box.
if [ "$("$NODE" -p "require('$TW_PREFIX/node_modules/taskwindow/package.json').version" 2>/dev/null)" != "$TASKWINDOW_VERSION" ]; then
	PATH="$(dirname "$NODE"):$PATH" "$NPM" install --prefix "$TW_PREFIX" --omit=dev --no-audit --no-fund \
		"taskwindow@$TASKWINDOW_VERSION" >/dev/null || die "npm install taskwindow@$TASKWINDOW_VERSION failed"
	TW_UPGRADED=1
fi
[ -f "$TW_ENTRY" ] || die "taskwindow installed without $TW_ENTRY"
# The version is pinned here, so the daemon must not tell agents to update it.
install -d -m 700 "$HOME/.taskwindow"
touch "$HOME/.taskwindow/no-update-check"

# ------------------------------------------------------------ services -----

# noVNC always listens on loopback: the desktop app's ssh forward is opened before
# it can ask the box anything, so 127.0.0.1 is the one address it can name. A box
# on a tailnet gets a second listener there, for clients that dial it directly.
LOOPBACK_VIEW_ADDR="127.0.0.1:6080"
VIEW_ADDR="${ATEAM_BROWSER_VIEW_ADDR:-}"
if [ -z "$VIEW_ADDR" ]; then
	HOST=""
	if [ -s "$DATA_DIR/ws-addr" ]; then HOST="$(head -1 "$DATA_DIR/ws-addr" | sed 's/:[0-9]*$//')"; fi
	if [ -z "$HOST" ]; then HOST="$(tailscale ip -4 2>/dev/null | head -1 || true)"; fi
	# Tailscale in userspace mode (boxd) owns no interface, and a bind to its IP
	# would fail on every restart.
	if [ -n "$HOST" ] && ! ip -4 -o addr show 2>/dev/null | grep -qF " $HOST/"; then HOST=""; fi
	if [ -n "$HOST" ] && [ "$HOST" != 127.0.0.1 ]; then VIEW_ADDR="$HOST:6080"; fi
fi
if [ -n "$VIEW_ADDR" ]; then SERVICES="$SERVICES ateam-novnc-tailnet"; fi

# name|needs|env|cmd|args — args comma-separated, as sprite-env takes them.
service_specs() {
	echo "ateam-xvfb|||$XVFB_LAUNCHER|"
	echo "ateam-openbox|ateam-xvfb|DISPLAY=$DISPLAY_NUM|/usr/bin/openbox|"
	echo "ateam-chrome|ateam-xvfb,ateam-openbox|DISPLAY=$DISPLAY_NUM|$CHROME_LAUNCHER|"
	echo "ateam-x11vnc|ateam-xvfb|DISPLAY=$DISPLAY_NUM|/usr/bin/x11vnc|-display,$DISPLAY_NUM,-localhost,-forever,-shared,-quiet,-rfbauth,$VNC_AUTH_FILE"
	echo "ateam-novnc|ateam-x11vnc||/usr/bin/websockify|--web,/usr/share/novnc,$LOOPBACK_VIEW_ADDR,127.0.0.1:5900"
	if [ -n "$VIEW_ADDR" ]; then
		echo "ateam-novnc-tailnet|ateam-x11vnc||/usr/bin/websockify|--web,/usr/share/novnc,$VIEW_ADDR,127.0.0.1:5900"
	fi
	echo "ateam-taskwindow||HOME=$HOME,TASKWINDOW_PORT=$TASKWINDOW_PORT|$NODE|$TW_ENTRY"
}

step "[4/6] run the browser stack as $SVC_MGR services"
if [ "$SVC_MGR" = systemd ]; then
	# System units, like install.sh's: they start on boot without a login session.
	while IFS='|' read -r name needs env cmd args; do
		{
			echo '[Unit]'
			echo "Description=Ateam browser: $name"
			if [ -n "$needs" ]; then
				echo "After=network.target ${needs//,/.service }.service"
				echo "Requires=${needs//,/.service }.service"
			else
				echo 'After=network.target'
			fi
			echo 'StartLimitIntervalSec=0'
			echo ''
			echo '[Service]'
			echo "User=$(id -un)"
			echo "WorkingDirectory=$HOME"
			for kv in ${env//,/ }; do echo "Environment=$kv"; done
			echo "ExecStart=$cmd ${args//,/ }"
			echo 'Restart=always'
			echo 'RestartSec=3'
			echo ''
			echo '[Install]'
			echo 'WantedBy=multi-user.target'
		} | sudo tee "/etc/systemd/system/$name.service" >/dev/null
	done < <(service_specs)
	sudo systemctl daemon-reload
	# `enable --now` starts what isn't running and leaves a running unit be, so a
	# re-run never closes the browser under an agent. A new TaskWindow is worth a
	# restart, and so is noVNC: it holds no state (a viewer reconnects), and a
	# running one would keep listening where an older run put it.
	# shellcheck disable=SC2086
	sudo systemctl enable --now $(printf '%s.service ' $SERVICES) >/dev/null 2>&1
	sudo systemctl restart ateam-novnc.service
	if [ -n "$VIEW_ADDR" ]; then sudo systemctl restart ateam-novnc-tailnet.service; fi
	if [ -n "${TW_UPGRADED:-}" ]; then sudo systemctl restart ateam-taskwindow.service; fi
else
	# On a Sprite, deleting or restarting a service kills what it started, so a
	# service already running this run's command is left exactly as it is. One
	# whose command differs is recreated: only a newer script changes a command, so
	# a mismatch is an install that predates a fix, and it may be crash-looping on
	# the old one (a looping service reads "running" between restarts, so its
	# status can't say). noVNC is recreated every run: it holds no state.
	#
	# A replaced service takes everything that needs it along (replacing
	# ateam-xvfb restarts Chrome, once per upgrade), and they go dependents first:
	# the specs are in dependency order, so they are marked forwards and deleted
	# backwards.
	stale=()
	while IFS='|' read -r name needs _ cmd args; do
		have="$("$SPRITE_ENV" services get "$name" 2>/dev/null | "$NODE" -e '
			let s = "";
			process.stdin.on("data", (d) => (s += d)).on("end", () => {
				try {
					const j = JSON.parse(s);
					console.log([j.cmd, ...(j.args || [])].join(","));
				} catch {}
			});' || true)"
		[ -n "$have" ] || continue
		replace=""
		case "$name" in ateam-novnc*) replace=1 ;; esac
		if [ "$have" != "$cmd${args:+,$args}" ]; then replace=1; fi
		for n in ${needs//,/ }; do
			case " ${stale[*]} " in *" $n "*) replace=1 ;; esac
		done
		if [ -n "$replace" ]; then stale+=("$name"); fi
	done < <(service_specs)
	for ((i = ${#stale[@]} - 1; i >= 0; i--)); do
		"$SPRITE_ENV" services delete "${stale[i]}" >/dev/null || die "couldn't replace ${stale[i]} (the error is above)"
		info "${stale[i]}: replaced"
	done
	while IFS='|' read -r name needs env cmd args; do
		if "$SPRITE_ENV" services get "$name" >/dev/null 2>&1; then
			info "$name: already a service, left running"
			continue
		fi
		set -- "$name" --cmd "$cmd" --no-stream
		if [ -n "$args" ]; then set -- "$@" --args "$args"; fi
		if [ -n "$env" ]; then set -- "$@" --env "$env"; fi
		if [ -n "$needs" ]; then set -- "$@" --needs "$needs"; fi
		"$SPRITE_ENV" services create "$@" >/dev/null
		info "$name: created"
	done < <(service_specs)
	if [ -n "${TW_UPGRADED:-}" ]; then "$SPRITE_ENV" services restart ateam-taskwindow >/dev/null; fi
fi

# -------------------------------------------------------------- verify -----

step "[5/6] wait for the extension to pair with the daemon"
# Chrome downloads the extension from the store on first start, so allow for it.
PAIRED=""
for _ in $(seq 1 90); do
	if curl -fsS "http://127.0.0.1:$TASKWINDOW_PORT/health" 2>/dev/null | grep -F '"extensionConnected":true' >/dev/null; then
		PAIRED=1
		break
	fi
	sleep 1
done
if [ -n "$PAIRED" ]; then
	info "TaskWindow: extension connected"
else
	info "WARNING: the extension hasn't connected yet. Check: curl -s 127.0.0.1:$TASKWINDOW_PORT/health"
fi

# ------------------------------------------------------------- agents ------

step "[6/6] register TaskWindow with the agent CLIs"
TOKEN_FILE="$HOME/.taskwindow/token"
for _ in $(seq 1 20); do
	[ -s "$TOKEN_FILE" ] && break
	sleep 1
done
[ -s "$TOKEN_FILE" ] || die "the TaskWindow daemon never wrote $TOKEN_FILE"
CLAUDE_BIN="$(bash -lc 'command -v claude' 2>/dev/null || true)"
if [ -n "$CLAUDE_BIN" ]; then
	# Re-added each run so a rotated token takes. `remove` fails when absent; fine.
	"$CLAUDE_BIN" mcp remove --scope user taskwindow >/dev/null 2>&1 || true
	"$CLAUDE_BIN" mcp add --scope user --transport http taskwindow \
		"http://127.0.0.1:$TASKWINDOW_PORT/mcp" \
		--header "Authorization: Bearer $(cat "$TOKEN_FILE")" >/dev/null
	info "Claude Code: taskwindow MCP server added (user scope); new sessions get it"
else
	info "no claude on the login PATH: add the MCP server to your agent by hand:"
	info "  http://127.0.0.1:$TASKWINDOW_PORT/mcp, header Authorization: Bearer <$TOKEN_FILE>"
fi

cat <<EOF

Browser ready. Watch and take over from the desktop app (the globe button on a
task on this box opens its Browser panel), or in any browser at:

    http://${VIEW_ADDR:-<ssh -L 6080:127.0.0.1:6080 this box, then> localhost:6080}/vnc.html#autoconnect=true&resize=scale

VNC password: $VNC_PASS_FILE. Log into a site there once and every agent on
this box shares the session. Agents reach Chrome through the taskwindow MCP
tools; CDP is also on 127.0.0.1:$CDP_PORT for anything that speaks it.
EOF
