# Running Ateam online (agents on a remote box)

Ateam is local-first: by default it runs your agents, worktrees, and git on **this
Mac**. "Online Ateam" points the same desktop app at a **remote box** instead — a
Linux server that runs the agents while your Mac stays a thin UI. Useful when you
want agents working around the clock, on a beefier machine, or reachable from your
phone.

The connection rides **SSH over [Tailscale](https://tailscale.com)**, so the box
exposes **no public ports** — it's only reachable on your private tailnet.

> **Renting a box instead?** [boxd](https://boxd.sh) microVMs work as an Ateam box too,
> reached over boxd's own authenticated SSH proxy rather than a tailnet — see "Start to
> finish on a boxd microVM" in the [README](../README.md#run-your-agents-on-a-server).
> Everything below still applies except the Tailscale setup; note the **iOS app can't
> use boxd**, since its kernel ships no TUN device for `tailscaled`.

## How it works

```
   your Mac                         your box (on the tailnet)
┌───────────────┐   SSH over      ┌──────────────────────────────┐
│ Ateam desktop │───Tailscale────▶│ ateam daemon                 │
│  (the UI)     │                 │  ├─ agents (claude, …)       │
│               │◀── JSON-RPC ────│  ├─ git worktrees            │
└───────────────┘                 │  └─ PTY sessions             │
                                  └──────────────────────────────┘
```

When you pick a box in the desktop's connection switcher, Ateam runs
`ssh <host> ateam attach --stdio`, which relays JSON-RPC to the box's daemon. If no
daemon is running yet, `attach` **starts one automatically** and waits for it — you
never have to start it by hand. The daemon (and its running agents) **outlives your
connection**: close the app or drop off Wi-Fi and the agents keep working; reconnect
and you re-attach to the same live sessions.

## Prerequisites

- A Linux box you can SSH into (Hetzner, EC2, a home server, …).
- A free **[Tailscale](https://tailscale.com)** account. Every device that talks to the
  box — your Mac, the box itself, your phone — installs Tailscale and signs into the
  **same account**; that shared private network is what replaces opening ports.
- The **Ateam desktop app** on your Mac.

**Install Tailscale on your Mac first** ([tailscale.com/download](https://tailscale.com/download)
— App Store or standalone), sign in, and leave it connected. Everything below assumes
your Mac is on the tailnet; without it you won't be able to reach the box's `100.x`
address at all once you've closed its public port.

## 0. Preparing a freshly bought VPS

Skip this if you already have a box you work on. Starting from a provider's
"create server" screen:

**Size it for agents, not for the app.** A recent Ubuntu LTS with **4 GB RAM, 2 vCPU,
40 GB disk** is a comfortable starting point — a Hetzner **CX23** (x86) or **CAX11**
(Arm64), or the equivalent elsewhere. Each concurrent agent session wants roughly a
gigabyte, plus whatever your project's own dev server and test runs need. x86_64 and
arm64 both work.

**Create a non-root user.** Agents run as this user, in its login shell, with its
git and `gh` credentials — don't give them root.

```bash
adduser you && usermod -aG sudo you
install -d -m 700 -o you -g you /home/you/.ssh
cp ~/.ssh/authorized_keys /home/you/.ssh/ && chown you:you /home/you/.ssh/authorized_keys
```

**Close the public door.** A fresh VPS answers on port 22 from the entire internet.
Once Tailscale is up (step 2), restrict SSH to the tailnet:

```bash
sudo ufw allow in on tailscale0    # everything, but only over the tailnet
sudo ufw deny 22                   # nothing from the public internet
sudo ufw enable
```

Two details matter. Allow the **whole `tailscale0` interface**, not just port 22 —
`ufw enable` sets the default incoming policy to deny, so a port-22-only rule would
also silently block the WebSocket port the iOS app needs (step 5). And run this only
**after** confirming Tailscale works, or you'll lock yourself out of your own server.

This is what makes the "no public ports" property below actually true.

**Give the box a git identity and a GitHub login.** Ateam's agents commit, push, and
open PRs as this user. Without an identity, every commit fails:

```bash
git config --global user.name  "you"
git config --global user.email "you@example.com"
git config --global init.defaultBranch main
gh auth login          # device-code flow — works fine over SSH
```

**Install the agent CLIs you want** (e.g. `claude`) and log into each one once, in an
interactive SSH session. The daemon only offers agents that are installed and on its
**login-shell** PATH.

## 1. Install the `ateam` server on the box

One command, run **on the box as your non-root user**:

```bash
curl -fsSL https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh | bash
```

It downloads the server bundle from the latest release, installs the two native
modules (prebuilt — the box needs no compiler), puts an `ateam` launcher on your
login-shell PATH, verifies the handshake, and finishes with a readiness report of
the things it can't do for you (git identity, `gh`, agent CLIs, Tailscale). Nothing
needs sudo; everything lands under your home directory.

If the box has no Node, or one too new for the native module prebuilds, the installer
installs **Node 22** via nvm into your home directory and uses that — the launcher
pins the exact interpreter the modules were built for, so a later `nvm use` can't
break it.

Re-run the same command to upgrade. Three knobs, all optional:

| Knob | Effect |
| --- | --- |
| `--service` | also install a `systemd --user` unit so the daemon survives logout and reboot (`… \| bash -s -- --service`). Required for the iOS app — see step 5. |
| `ATEAM_VERSION=v0.1.30` | install a specific release instead of the latest |
| `ATEAM_TARBALL=<url\|path>` | install from your own `ateam-server.tar.gz` (dev builds, air-gapped boxes) |

<details>
<summary>Installing from a local checkout instead</summary>

If you're working on Ateam itself, `packages/server/scripts/install-remote.sh` builds
the dist on your Mac and pushes it over SSH in one shot:

```bash
SSH_FLAGS="-i ~/.ssh/mykey" packages/server/scripts/install-remote.sh you@your-box
```
</details>

## 2. Put the box on your tailnet

Install Tailscale on the box and bring it up. `tailscale up` prints a URL — open it and
sign in with the **same account** your Mac uses, or the two won't see each other:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Note the box's **tailnet IP** (`100.x.y.z`) or its MagicDNS name (`tailscale ip -4`).
Check both ends agree with `tailscale status` — the box should appear in your Mac's
list before you go further.

## 3. Add the box to `~/.ssh/config` (on your Mac)

The desktop lists whatever it finds in your SSH config. Add a `Host` entry pointing
at the box's **tailnet** address:

```sshconfig
Host my-ateam-box
    HostName 100.x.y.z        # the box's Tailscale IP (or MagicDNS name)
    User you
    # IdentityFile ~/.ssh/id_ed25519   # if you use a specific key
```

Test it:

```bash
ssh my-ateam-box "bash -lc 'ateam'"
```

## 4. Connect from the desktop app

1. Open Ateam. Top-right of the toolbar is the **connection button** — it shows
   **Local** with a laptop icon.
2. Click it. The menu lists **This Mac** plus every `Host` in your SSH config.
3. Pick **my-ateam-box**. Ateam handshakes with the box (starting its daemon if
   needed) and the board reloads with the **box's** projects and tasks. The button
   turns green and shows the host name.
4. Work as usual — new tasks, agents, terminals, and git all run **on the box**.
5. Switch back to your Mac anytime via **This Mac**.

## 5. Same box, from the iOS app

The phone can't run `ssh`, so it speaks to the **same daemon** over a WebSocket
instead — same engine, same agents, same worktrees, still only over your tailnet. The
listener is **off by default**, and the phone needs the daemon to be **already
running**: unlike the desktop it can't start one on demand, because the WebSocket only
exists once a daemon is up.

So the phone path is one install with both: the address to listen on, and a service
to keep something listening.

```bash
export ATEAM_WS_ADDR=100.x.y.z:8787     # the box's OWN Tailscale IP
curl -fsSL https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh | bash -s -- --service
```

That writes a `systemd --user` unit carrying `ATEAM_WS_ADDR`, enables lingering so it
survives logout **and reboot**, and starts it. No sudo — enabling lingering for your
own user is unprivileged.

The address **must be the box's own `100.x`**: a wildcard bind (`0.0.0.0` / `::`) is
refused and the daemon exits. This socket carries no auth of its own, exactly like
the unix socket — the tailnet is the auth boundary.

If a daemon is already running outside systemd, the installer will **not** kill it. It
enables the service for next boot and prints the handover for you to run when it
suits — your agents keep running across it:

```bash
pkill -f 'ateam-app/cli.js daemon' && systemctl --user start ateam
```

From then on, systemd owns the daemon:

```bash
systemctl --user restart ateam     # instead of pkill
systemctl --user status ateam
journalctl --user -u ateam -f      # → daemon also listening on ws://…
```

Restarting does **not** kill your running agents. The unit is `KillMode=process`, so
only the RPC daemon is replaced; the detached PTY daemon holding every live session is
deliberately left alone.

**On the phone:** install **Tailscale** from the App Store, sign into the *same*
tailnet, and make sure its VPN toggle is on. Then open Ateam Go, enter the box's
Tailscale IP and port `8787`, and connect — the connection is remembered across
launches. Allow the iOS **Local Network** prompt if it appears.

**What still needs a computer.** Everything above — don't try to defer it. The phone
has nothing to connect to until a daemon is listening, and once connected the app can
only add a project by browsing the box for a repo that is **already cloned there**
(`projects.register` rejects a path that isn't a git repo). Its terminal lives inside
a task's worktree, so there is no free-standing shell to clone that first repo with.
Do steps 0–4 in one SSH session.

After that, the phone is enough: its terminal is a real login shell on the box, so
re-logging into `claude` when a session expires, `gh auth refresh`, and cloning
further repos all work from the app.

### Write a Tailscale ACL — this one isn't optional

A new tailnet's policy **allows every device to reach every other device on every
port**; restricting that takes an explicit policy file. And this port isn't a
read-only status page — the engine behind it spawns shells, so reaching it is a login
on the box with your `gh` token and your repos.

So before you leave the listener on, scope it in your
[tailnet policy file](https://tailscale.com/kb/1018/acls) to just the devices that
should have it — your phone and your Mac, not "anything I ever add to this tailnet":

```jsonc
{
  "acls": [
    { "action": "accept", "src": ["your@email"], "dst": ["tag:ateam-box:8787"] },
  ],
}
```

The SSH transport doesn't need this — OpenSSH authenticates with your key regardless
of who can reach port 22. It's specific to the WebSocket, which deliberately has no
auth of its own.

**And know what the phone holds.** There's no app lock yet, so an unlocked, stolen
phone on your tailnet is shell access to the box. Right now the tailnet is the only
thing between the two.

> **Without `--service`**, nothing re-launches the daemon after a reboot. That's fine
> for desktop-only use — `ssh … ateam attach` starts one on demand — but it strands a
> phone, which has no way to start one. Install the service if you use the app.

## Troubleshooting

The connection menu surfaces the real error inline. Common ones:

| Symptom | Fix |
| --- | --- |
| **"No servers in ~/.ssh/config"** in the menu | Add a `Host` entry (step 3). |
| Connect hangs or fails | Check `ssh <box>` works, Tailscale is up on **both** ends (`tailscale status`), and `ateam` is on the box's login PATH: `ssh <box> "bash -lc 'command -v ateam'"`. |
| **"Protocol mismatch"** | The Mac app and box server are different versions — re-run the installer on the box (step 1), or update the desktop app, so both speak the same protocol. |
| Board is empty after connecting | The box has no registered projects yet — add one from the box's filesystem via **Add project** (or register a repo path on the box). |
| Agents run but commits fail | The box has no git identity — `git config --global user.name/user.email` (step 0). |
| The agent picker is empty | The agent CLI isn't on the box's **login** PATH: `ssh <box> "bash -lc 'command -v claude'"`. |
| The iOS app won't connect | In order: is Tailscale's VPN toggle on on the phone; is a daemon running at all (`systemctl --user status ateam`); does it say `also listening on ws://…` (if not it started before `ATEAM_WS_ADDR` was set — `systemctl --user restart ateam`); does `sudo ufw status` allow the **tailscale0 interface**, not just port 22. |

## Notes

- **Nothing is exposed publicly.** Both transports are reachable only over your
  tailnet — no port is open to the internet, and neither carries auth of its own
  because the tailnet *is* the auth boundary.
- **The same box also backs the iOS app** — see step 5. Same daemon, agents, and
  worktrees; a WebSocket instead of SSH, both riding Tailscale.
- **Sessions persist.** The daemon keeps agents and PTYs alive across disconnects;
  reconnecting re-attaches to the exact running sessions.
