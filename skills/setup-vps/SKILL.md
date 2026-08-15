---
name: setup-vps
description: Prepare a Linux VPS to run Ateam's agents, and connect the desktop app to it over SSH. Use when the user has bought (or is about to buy) a server for Ateam, says "set up my VPS", "run agents on my server", "connect Ateam to my box", "run agents 24/7", or wants the same box to back the iOS app.
---

# Set up a VPS for Ateam

Takes a box from "just bought it" to "the desktop app's connection switcher lists it
and agents run there". The mechanical half is one installer script; your job is the
half that needs judgment and a human at a browser.

The connection is **SSH over [Tailscale](https://tailscale.com)** — the box ends up
with no public ports at all. Reference docs: `docs/online-ateam.md` in this repo.

## Before you touch anything

Ask the user what they have, and don't assume:

- **A box already, or shopping?** If shopping: a recent Ubuntu LTS with 4 GB RAM,
  2 vCPU, 40 GB disk is the comfortable floor — a Hetzner CX23 (x86) or CAX11 (Arm64),
  or the equivalent elsewhere. Agents are the RAM consumer — roughly a gigabyte per
  concurrent session, plus their project's own dev server and tests. x86_64 and arm64
  both work.
- **Can they SSH in as a non-root user?** Providers hand you `root`. Agents must not
  run as root — they get a login shell, git credentials, and a `gh` token.
- **Is Tailscale already on their Mac?** Check before anything else. Every device that
  talks to the box — Mac, box, phone — needs Tailscale signed into the *same account*
  ([tailscale.com/download](https://tailscale.com/download) for the Mac, the App Store
  for iOS, the install script on the box). It's what lets them close port 22, and a
  Mac that isn't on the tailnet simply can't reach the box afterwards. Easy to install
  the box side and forget the Mac side, then wonder why SSH stopped working.
- **Which agent CLIs do they want on the box** (e.g. `claude`)? Each needs its own
  interactive login there.

## 1. Non-root user

Skip if they already have one. As root on the box:

```bash
adduser <user> && usermod -aG sudo <user>
install -d -m 700 -o <user> -g <user> /home/<user>/.ssh
cp ~/.ssh/authorized_keys /home/<user>/.ssh/ && chown <user>:<user> /home/<user>/.ssh/authorized_keys
```

Confirm `ssh <user>@<box>` works before going further.

## 2. Tailscale, then close port 22

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4          # note the 100.x.y.z address
```

**Verify the tailnet address works from the Mac before firewalling** — get an
`ssh <user>@100.x.y.z` in, then:

```bash
sudo ufw allow in on tailscale0    # everything, but only over the tailnet
sudo ufw deny 22                   # nothing from the public internet
sudo ufw enable
```

Allow the **whole `tailscale0` interface**, not a single port: `ufw`'s default input
policy is DROP, so a port-22-only rule silently blocks the WebSocket port the iOS app
needs later.

Do these in this order or the user locks themselves out of their own server. If they
would rather not run Tailscale, everything else still works — but say plainly that
they are then choosing to leave SSH exposed to the internet, and key-only auth
(`PasswordAuthentication no`) becomes mandatory rather than advisable.

## 3. Install the server

As the non-root user, on the box:

```bash
curl -fsSL https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh | bash
```

The installer handles Node (installing Node 22 via nvm if the box has none or one too
new for the native-module prebuilds), the dist, the two native modules, the
`~/.local/bin/ateam` launcher, the login-shell PATH, and a real `system:hello`
handshake. It needs no sudo and is safe to re-run to upgrade.

It ends with a **readiness report** of what it deliberately does not do for the user.
Work that list — it is the whole point of the next step.

## 4. The things the installer reports but can't do

**Git identity** — without it, every agent commit fails:

```bash
git config --global user.name "<name>"
git config --global user.email "<email>"
git config --global init.defaultBranch main
```

**GitHub** — Ateam's merge queue and PR flow shell out to `gh`:

```bash
gh auth login        # device-code flow, works over SSH
```

**Agent CLIs** — install each one the user wants and log into it **interactively over
SSH**. Auth is a browser round-trip; it cannot be scripted, and an agent that isn't
logged in fails at first use, not at install. The daemon only advertises agents on
its **login-shell** PATH — check with `ssh <box> "bash -lc 'command -v claude'"`, not
a plain `ssh <box> "command -v claude"`.

## 5. Connect the Mac

Add the box to `~/.ssh/config` **using its tailnet address** — the desktop lists
whatever it finds there:

```sshconfig
Host <alias>
    HostName 100.x.y.z
    User <user>
    IdentityFile ~/.ssh/<key>
```

Then in Ateam: the connection button (top-right, shows **Local**) → pick `<alias>`.
The board reloads with the box's projects and the button turns green.

## Done means

All four, verified — not just "the installer printed OK":

1. `ssh <alias> "bash -lc 'ateam'"` prints the usage line.
2. The installer's readiness report is all `[ok]`.
3. The desktop connects and the connection button shows the host name.
4. A task actually runs on the box: create one, watch the agent start in its terminal.

Anything short of 4 means it isn't set up — a green connection with no working agent
is the common half-finished state.

## Common failures

| Symptom | Cause |
| --- | --- |
| Install fails on native modules | Node too new for the prebuilds. The installer falls back to Node 22 itself; if it still fails, the box is on an unsupported libc or arch. |
| `ateam` not found over SSH, works when logged in | It's on the interactive PATH but not the **login** PATH. The installer edits the first of `~/.bash_profile`, `~/.bash_login`, `~/.profile` that exists — check which one bash actually reads there. |
| Connect hangs | Tailscale down on one end (`tailscale status` on both), or the host key rotated after a box rebuild (`ssh-keygen -R <ip>`, then reconnect). |
| "Protocol mismatch" | Desktop and box are different versions — re-run the installer, or update the app. |
| Agent picker empty | No agent CLI on the login PATH, or the daemon was started from a non-login shell. |
| Commits fail | No git identity on the box (step 4). |

## If they also want the iOS app (Ateam Go)

Same box, same daemon — the phone can't run `ssh`, so it uses a WebSocket. Opt-in,
off by default. Do this only when asked; it opens a port on the tailnet.

A phone needs the daemon **already running** — it can't start one the way the desktop
does over SSH, since the WebSocket only exists once a daemon is up. So the phone path
requires the service:

```bash
export ATEAM_WS_ADDR=<box-tailnet-ip>:8787
curl -fsSL https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh | bash -s -- --service
```

The unit carries `ATEAM_WS_ADDR`. A wildcard bind is refused and the daemon exits —
the socket has no auth of its own, so the bind address must be the box's own `100.x`.

Where passwordless sudo exists the installer writes a **system** unit; otherwise a
`--user` one kept alive by lingering. Prefer the system unit for any box a phone
uses: only it can set `OOMScoreAdjust=-500`, without which the kernel kills this
daemon *before* the far larger agents it supervises, and only the phone can't
recover from that on its own. Check which you have with `systemctl status ateam`
vs `systemctl --user status ateam`.

If a daemon is already running outside systemd the installer will **not** kill it; it
prints the handover instead. Running agents survive it:

```bash
pkill -f 'ateam-app/cli.js daemon' && systemctl start ateam   # --user for a user unit
systemctl restart ateam    # the restart command from here on
```

Don't reach for `pkill` afterwards — `systemctl --user restart` is the supported
path, and the unit is `KillMode=process` so the detached PTY daemon holding live
agent sessions is deliberately left running across a restart.

**On the phone:** Tailscale from the App Store, signed into the *same* tailnet, VPN
toggle on. Then in Ateam Go enter the box's Tailscale IP and port `8787`. Allow the
iOS Local Network prompt if it appears. (`ateamgo://demo` opens an offline demo — it
does **not** configure a connection.)

If the user asks whether they can skip the SSH steps and do the setup from the phone
instead: **no, and say why.** The phone has nothing to connect to until a daemon is
listening; the app adds a project only by browsing the box for an already-cloned repo
(`projects.register` throws `NOT_A_REPO` otherwise); and its terminal only exists
inside a task's worktree, so there's no shell to clone that first repo with. It's a
five-minute SSH session, once. Afterwards the phone's terminal *is* a login shell on
the box — re-auth, `gh auth refresh` and further clones are all fine from it.

Say both of these out loud, don't bury them:

- **A Tailscale ACL is required, not advisable.** A new tailnet allows every device
  to reach every other on every port, and the engine behind this one spawns shells —
  so reaching it is a login on the box. Scope it in the tailnet policy file to the
  devices that should have it before leaving the listener on. This applies only to
  the WebSocket; SSH authenticates with a key no matter who can reach port 22.
- **There's no app lock yet.** An unlocked stolen phone on the tailnet is shell
  access to the box.
