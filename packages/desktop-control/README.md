# Desktop control

An independent MCP server for a shared Linux X11 desktop, packaged inside Ateam.
It runs without an Ateam engine or database. Ateam supplies installation, agent
configuration, and a panel that opens its viewer.

## Run

Requires Node 22+, Xvfb (or another X11 display), a window manager, `xdotool`,
`scrot`, `x11vnc`, and noVNC's browser modules at `/usr/share/novnc`. The VNC
server must use RFB 3.8 with VNC password authentication on loopback port 5900.
Wayland and control of a user's macOS/Windows desktop are outside this version.

```sh
bun run --cwd packages/desktop-control build
DISPLAY=:99 node packages/desktop-control/dist/desktop.cjs
```

The default listener is `127.0.0.1:6080`. Two credentials are created with mode
0600 in `~/.desktop-control`: `desktop-token` for MCP clients and
`desktop-viewer-token` for human viewers. Register `http://127.0.0.1:6080/mcp`
as a Streamable HTTP MCP server, with header `Authorization: Bearer <desktop-token>`.
The server returns JSON responses; it does not need a persistent SSE connection.

Open `/vnc.html#password=<VNC-password>&controlToken=<desktop-viewer-token>` to
watch and take over. Keep credentials in the fragment, which is not sent in
HTTP requests. Use an SSH tunnel or a private tailnet, not a public listener.
The viewer sends its credential in the WebSocket subprotocol header. It is
separate from the MCP credential, so agents do not receive human takeover access.

Configuration:

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `DISPLAY` | `:99` | X11 display |
| `DESKTOP_CONTROL_DIR` | `~/.desktop-control` | Credential directory |
| `DESKTOP_LISTEN` | `127.0.0.1:6080` | Primary IPv4/hostname listener |
| `DESKTOP_LISTEN_EXTRA` | unset | Optional private second listener, same owner/lease |
| `DESKTOP_NOVNC_ROOT` | `/usr/share/novnc` | Distribution's noVNC JavaScript files |

## Tools and ownership

`control` supports `status`, `acquire` (with a task label), `renew`, and `release`.
Acquire returns an opaque lease. Input through `computer` requires that lease;
screenshots do not. Leases expire after 90 seconds without input or renewal.
A second agent must wait; there is no agent force-takeover operation.

`computer` supports `screenshot`, `left_click`, `right_click`, `double_click`,
`mouse_move`, `type`, `key`, and `scroll`. Coordinates refer to full-resolution
PNG pixels, regardless of how the viewer scales the display. `key` accepts
combinations such as `Control+s` and `Shift+Tab`. `type` sends real key events,
including explicit Return/Tab events, with a 4000-character limit. LF/CRLF are
normalized to Return. It is typing, so the focused application's shortcuts,
autoindent, and text transformations still apply. Scroll amounts are wheel
steps (1–20) at the current pointer position.

The viewer fills its frame, with controls collapsed behind the corner button.
Open it to take/release control or use the phone text field. The Ateam installer
sets a dark wallpaper on the actual X desktop and restores it at display startup.

The viewer starts in watch mode. **Take control** revokes the agent lease,
cancels its running input, waits for key cleanup, and permits only that viewer's
input. **Release control** or disconnect makes the desktop available again.
A broken connection is detected by WebSocket heartbeat (within 20 seconds).
A second viewer can explicitly take over too. Server-side RFB framing/filtering
blocks stale viewer keys, pointer events, clipboard writes and resize requests;
held keys/buttons are released on handoff. Unknown RFB extensions fail closed.
The text bar also allows text entry from a phone's software keyboard.

This coordinates clients of this service. It is **not OS isolation**: local
processes with access to X11 or raw VNC, and TaskWindow's independent CDP tools,
are outside its lock. Tasks needing simultaneous native desktops need separate
displays/VMs. This first version has one desktop per box.

## Ateam integration

The server release bundles `desktop.js` beside `cli.js`. After updating the
engine, run `packages/server/scripts/install-browser.sh` on the box (or use
Ateam's browser installation flow for a new box). Existing browser installations
need that installer rerun once to replace websockify with the controlled viewer.
It preserves Chrome, the profile, the X display and the VNC password. The
`ateam-novnc` service now runs this package and owns both loopback and optional
tailnet listeners; the old separate tailnet websockify service is stopped.

Ateam stores credentials under its data directory's `browser/` folder and
registers the MCP server for newly launched Claude, Codex and OpenCode task
sessions. Existing conversations need a relaunch to discover it. The updated
macOS and iPhone clients carry the viewer credential in the URL fragment; older
clients must be updated before using the new viewer. TaskWindow remains the
browser tool and is unchanged.

## Verify

```sh
bun test packages/desktop-control/test
bun run --cwd packages/desktop-control typecheck
# On an isolated Linux desktop, with Mousepad installed (uses actual MCP input):
DESKTOP_CONTROL_DIR="$HOME/.ateam/browser" bun run --cwd packages/desktop-control test:linux
```

The live check opens its own temporary document, types multilingual text, uses
Control+s, compares the saved bytes, and captures a PNG. Run it only on a test
display: launching an application changes its focus. Unit/integration checks
cover conflicting leases, expiry, cancellation, stale queued actions, fragmented
VNC messages, held keys, and HTTP authentication boundaries.
