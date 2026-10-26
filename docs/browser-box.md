# A browser on every box (spec)

Agents on a remote box should be able to drive a **real, headed Google Chrome** —
the same way the Clawnify gateway gives its OpenClaw agents one — and a human
should be able to **watch and steer that same browser from the desktop app and
the phone**, over noVNC. This document is the implementation spec. It is written
to be self-contained, but the stack it describes is **not speculative**: it is a
port of the Chrome stack that has been running in production on every Clawnify
VPS since v2026.3.28, with the hard-won fixes carried over verbatim.

**Status: proposal — not yet implemented. Phases below are ordered work items.**

## What exists already, and this rides on all of it

Nothing here invents a new subsystem. Every piece has a direct precedent in this
repo, and the implementation should mirror them closely:

| Precedent | Where | What we copy |
|---|---|---|
| In-app VS Code on the box | `packages/server/src/editor.ts` | Engine module that runs/installs an HTTP app on its own machine; client decides how to reach the port. `editor:open` / `editor:install` RPC shape, `needsInstall` result. |
| Reaching that port over SSH | `apps/desktop/src/main/editor-tunnel.ts` | An `-L` local forward opened WITH the RPC connection (deterministic local port per alias), so the tunnel lives and dies with the connection. |
| Embedding the HTTP app in the desktop | The Editor tab's iframe in the renderer | An iframe pointed at the forwarded port. |
| Non-invasive per-worktree agent config | `packages/server/src/agent-setup/index.ts` | Register things in each worktree's local config (`.claude/settings.local.json` there; `.mcp.json` here) instead of the user's global files. |
| The phone reaching an HTTP port on the box | The Preview modal (`apps/mobile/App.tsx`) | The phone is already on the tailnet and knows the box's address from its WebSocket connection — an HTTP URL on the same host needs no new transport. |
| Vendored HTML assets in the mobile app | `apps/mobile/src/terminal-html.ts` + `apps/mobile/scripts/gen-xterm-assets.mjs` | Generate assets offline, inline them, bridge via `postMessage`. |

The prior art for the box-side stack lives in the **clawnify/clawnify** repo
(`docs/internal/chrome-stack.md` is its canonical doc; everything is emitted from
`apps/api/src/services/cloudinit.ts`). The relevant sections of that file are
inlined below so this spec stands alone.

## Phase 1 — the box-side stack

### Packages and install

Installed via apt (plus Google's `.deb` for Chrome itself):

```
xvfb openbox x11vnc novnc websockify xdotool scrot
libgbm1 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2
libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3
libxrandr2 libpango-1.0-0 libcairo2 libasound2
```

Chrome itself comes from
`https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb`,
`dpkg -i`'d with `--fix-broken`. **arm64 caveat (Clawnify never hit this — its
fleet is x86): Google ships no arm64 .deb.** On an arm64 box (a Hetzner CAX
instance, for example) install the distro's `chromium` package instead and use
its executable path. The unit below must be generated with whichever executable
was actually installed.

Unlike code-server, **this install needs root** — apt, a system systemd unit and
a managed Chrome policy all require sudo. `install.sh` is deliberately no-sudo
and stays that way: the browser stack is a separate, opt-in setup that mirrors
`installCodeServer`'s shape — an engine-side function that runs the script and
reports failure reasons, with consent living with the caller (the client relays
the user's yes before anything runs). If the box has no sudo, report a clear
reason and stop; do not half-install.

### Pre-seeded preferences (carry over exactly — these kill the first-run bubbles)

Before Chrome ever starts, write into BOTH `~/.config/google-chrome` and the
user-data dir used by the service:

- a `Preferences` JSON with the first-run/search-picker/infobar keys Clawnify
  sets, plus `profile.exit_type = "Normal"` (otherwise every boot shows a
  "Restore pages?" bubble over the VNC view),
- an empty `First Run` sentinel file,
- and in the browser-wide `Local State`:
  `devtools.remote_debugging.user-enabled = true` — the consent gate for
  Chrome's own DevTools tooling; pre-flipping it means no dialog ever blocks the
  agent.

Plus a managed policy at
`/etc/opt/chrome/policies/managed/suppress-infobars.json`
(`{"CommandLineFlagSecurityWarningsEnabled": false}`) — without it Chrome paints
an "unsupported flag" infobar over the window because of the CDP flags.

These three fixes are idempotent and must also run as `ExecStartPre` on every
start (a killed Chrome flips `exit_type` back to `Crashed`).

### systemd units

All as **system** units (the desktop stack must be up before any client
connects; a `--user` unit dies with the login session — same reasoning as
install.sh's `--service`).

**`xvfb.service`** — the virtual display Chrome heads onto, so noVNC shows a
real browser, not a headless one:

```ini
[Unit]
Description=Xvfb virtual display :99
[Service]
ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x720x24
Restart=always
RestartSec=3
```

**`openbox.service`** — a window manager is required for window operations, and
configured **focus-follows-mouse** so VNC clicks land where they look like they
land:

```ini
[Unit]
Description=Openbox on :99
After=xvfb.service
Requires=xvfb.service
[Service]
Environment=DISPLAY=:99
ExecStartPre=/bin/sh -c 'mkdir -p ~/.config/openbox && printf "<openbox_config><focus><focusNew>yes</focusNew><followMouse>yes</followMouse></focus></openbox_config>" > ~/.config/openbox/rc.xml'
ExecStart=/usr/bin/openbox
Restart=always
RestartSec=3
```

**`chrome.service`** — the whole point of the exercise. CDP binds loopback only:

```ini
[Unit]
Description=Google Chrome (agent browser)
After=xvfb.service openbox.service
Requires=xvfb.service
[Service]
Environment=DISPLAY=:99
ExecStartPre=/opt/ateam/fix-chrome-prefs.sh
ExecStart=/usr/bin/google-chrome --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=%h/.ateam/browser/user-data \
  --no-first-run --disable-session-crashed-bubble --lang=en-US \
  --start-maximized --window-size=1280,720 https://www.google.com/?hl=en
ExecStartPost=/opt/ateam/write-devtools-port.sh
Restart=always
RestartSec=3
```

Two hard-won details:

- `fix-chrome-prefs.sh` is the idempotent Preferences/`Local State` fixer from
  above, run as `ExecStartPre`.
- **`write-devtools-port.sh`**: Chrome 146+ no longer writes the
  `DevToolsActivePort` file into the user-data dir, and several CDP consumers
  (including chrome-devtools-mcp) still expect it to discover the endpoint. The
  script polls `http://127.0.0.1:18800/json/version` for up to 10 s and writes
  the port + websocket path into the user-data dir.

**`x11vnc.service`** — VNC of that same display, loopback only, password
protected. The password is generated per box on first setup (16 chars), stored
at `~/.ateam/browser/vnc-pass`, `chmod 600`, and handed to clients only over the
authenticated RPC connection:

```ini
[Unit]
Description=x11vnc for :99
After=xvfb.service
Requires=xvfb.service
[Service]
ExecStart=/usr/bin/x11vnc -display :99 -localhost -forever -shared \
  -passwdfile %h/.ateam/browser/vnc-pass
Restart=always
RestartSec=3
```

**`novnc.service`** — the websocket bridge; this is the port clients actually
touch. It binds **only** where the operator told it to (see the security model
below):

```ini
[Unit]
Description=noVNC websocket bridge
After=x11vnc.service
Requires=x11vnc.service
[Service]
Environment=ATEAM_VNC_ADDR=127.0.0.1:6080
ExecStart=/usr/bin/websockify --web /usr/share/novnc ${ATEAM_VNC_ADDR} 127.0.0.1:5900
Restart=always
RestartSec=3
```

Enable all five at the end of setup, `systemctl enable --now`.

### Ateam wiring (engine + protocol)

- **`packages/server/src/browser.ts`** — mirrors `editor.ts`: `installBrowser()`
  (runs the setup script with sudo, consent with the caller),
  `findChrome()`-style probes, `browserStatus()` (are the units up, is CDP
  answering on 18800, is websockify listening), and the generated VNC password.
- **Protocol** (mirror the `editor:*` channels): `browser:install`,
  `browser:open` (returns a `BrowserEndpointDTO` — the websockify port — or
  `{ needsInstall: true }`), `browser:status`. `DEFAULT_BROWSER_VNC_PORT = 6080`
  and `DEFAULT_CDP_PORT = 18800` live in `@ateam/protocol` like
  `DEFAULT_EDITOR_PORT`.
- The setup script itself lands at `packages/server/scripts/browser-setup.sh`,
  installable standalone over SSH the way `install.sh` is.

### Agent control — the one real difference from Clawnify

Clawnify's agents are OpenClaw, which ships a bundled `browser` plugin that
attaches over raw CDP. Ateam's agents are bare CLIs, so they need an **MCP
server** instead — and one already exists: **`chrome-devtools-mcp`**, which
Clawnify itself installs fleet-wide, pointed at the very same kind of
server-managed Chrome:

- When the browser stack is up (and the user has opted the box into it — see
  below), the engine writes a per-worktree **`.mcp.json`** registering
  `chrome-devtools-mcp` with `--browserUrl http://127.0.0.1:18800`. Per-worktree,
  not global — the same non-invasive posture as `agent-setup`'s hook
  registration. The OpenCode/Codex equivalents get the same server in their own
  worktree-local config.
- **Raw CDP URL, no driver that launches its own browser.** Clawnify's
  fleet-wide incident (see its `docs/internal/upgrade-testing.md`) was exactly
  this: a "manage the browser for me" driver spawns a second Chrome or
  crash-loops against the service-managed one. Nothing but `chrome.service`
  ever launches Chrome; everything else attaches.
- CDP on 18800 **never leaves loopback**. The agent CLIs run on the box, so
  this is not a limitation; it is the security boundary.
- `xdotool` and `scrot` are installed so agents can drive and screenshot
  **non-browser** things on `:99` too (a dev server's native dialog, a desktop
  app), the same way Clawnify's agent instructions describe.

**Acceptance (Phase 1):** on a fresh box, run the setup; `systemctl status` all
five units green; `curl 127.0.0.1:18800/json/version` answers; a task's agent can
navigate, snapshot, click and screenshot through the MCP tool; a second agent
session attaches to the same Chrome; killing Chrome recovers in ≤3 s with no
"Restore pages?" bubble.

## Phase 2 — watching it from the desktop

Exactly the editor's shape:

- **`apps/desktop/src/main/browser-tunnel.ts`** mirroring `editor-tunnel.ts` —
  an `-L` forward to `127.0.0.1:6080` opened with the RPC connection, a
  deterministic local port per alias from a **separate** port range (the editor
  already hashes into 8391–8890; pick a fresh base, e.g. 8691 — don't collide),
  wired into the same place `host.ts` adds the editor flags.
- The renderer embeds `http://127.0.0.1:<local-port>/vnc.html?autoconnect=true`
  in an iframe beside/alongside the Editor tab, with the VNC password supplied
  by the main process (same IPC path the editor URL takes). Show `needsInstall`
  the way the editor does, with an install button that relays consent to
  `browser:install`.
- **`ws`-type boxes** (already on the tailnet, no SSH): no tunnel — the client
  opens `http://<box-host>:6080` directly, the same branching `host.ts` already
  does for the editor.

**Acceptance (Phase 2):** with an SSH-box connected, the noVNC view shows the
Chrome desktop, keystrokes and clicks round-trip, the view dies with the
connection and comes back on reconnect; a ws box needs no tunnel.

## Phase 3 — watching it from the phone

The phone already holds the box's address (its WebSocket target). The noVNC
endpoint is that same host on the websockify port:

- **tailnet boxes**: the websockify unit should bind the tailnet address rather
  than loopback when the operator asks for phone access — `ATEAM_VNC_ADDR`
  behaves exactly like `ATEAM_WS_ADDR` in `cli.ts`, including **refusing
  wildcard binds**.
- **boxd boxes**: same recipe as the phone's WebSocket — userspace Tailscale +
  `tailscale serve --bg --tcp 6080 tcp://localhost:6080` (documented per-box
  manual step in `docs/providers/boxd.md`, next to the existing 8787 one), or
  the org-level edge integration if enrolled.
- **In the app**: a Browser/VNC screen built on `react-native-webview` with
  **vendored noVNC assets** — the `terminal-html.ts` pattern (assets generated
  offline by a script like `gen-xterm-assets.mjs`, password injected over the
  bridge rather than in the URL, `autoconnect` on load). A plain system-browser
  link works as a first cut; the vendored screen is the polished path and keeps
  the user in the app.

**Acceptance (Phase 3):** from the phone, on tailnet, the live browser renders
and is steerable; on a boxd box with the serve recipe, the same; the password is
never in a URL.

## Security model

Ateam has no cloud edge — the tailnet is the boundary (the WS listener already
takes exactly this posture). So:

- CDP (18800): loopback, always, no exceptions.
- x11vnc (5900): loopback, password-protected.
- websockify (6080): binds the explicit address it was given and **refuses
  wildcard binds** — `0.0.0.0` must hard-fail the same way `ATEAM_WS_ADDR` does.
- The VNC password is generated on the box, never leaves it except over the
  authenticated RPC, and is per-box.
- No new public ports, no relay service, no tunnel provider.

## Documentation to update with the implementation

- `docs/online-ateam.md` — a "Browser on the box" section.
- `docs/providers/boxd.md` — the `tailscale serve` line for 6080 next to 8787.
- README's remote-agents section gains one sentence pointing at the doc.

## Out of scope (deliberately)

- No browser sandbox/profile-per-task (Clawnify runs one shared profile so
  logins persist for the agent — we match that; per-task profiles can come later
  if asked for).
- No PDF generation or hosted web-scraping tools — this is the agent's browser,
  not a service.
- No auto-provisioning of the stack: it's opt-in per box, like the editor's
  install button.
