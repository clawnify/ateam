# Running Ateam online (agents on a remote box)

Ateam is local-first: by default it runs your agents, worktrees, and git on **this
Mac**. "Online Ateam" points the same desktop app at a **remote box** instead — a
Linux server that runs the agents while your Mac stays a thin UI. Useful when you
want agents working around the clock, on a beefier machine, or reachable from your
phone.

The connection rides **SSH over [Tailscale](https://tailscale.com)**, so the box
exposes **no public ports** — it's only reachable on your private tailnet.

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
- **Node ≥ 22** on the box (`node --version`).
- **Tailscale** installed on both the Mac and the box, joined to the **same tailnet**.
- The **Ateam desktop app** on your Mac.

## 1. Install the `ateam` server on the box

The server ships as a small standalone bundle. Build it on your Mac from the repo,
copy it over, and install the two native modules on the box (they're prebuilt — the
box needs no compiler).

**On your Mac** (in the repo):

```bash
cd packages/server
bun run build                       # → dist/{cli.js, daemon.js, package.json}
scp -r dist "<box>:~/ateam-app"     # <box> = your ssh host (see step 3)
```

**On the box:**

```bash
cd ~/ateam-app
npm install                         # fetches better-sqlite3 + prebuilt node-pty

# put `ateam` on your login-shell PATH
mkdir -p ~/.local/bin
printf '#!/usr/bin/env bash\nexec node "$HOME/ateam-app/cli.js" "$@"\n' > ~/.local/bin/ateam
chmod +x ~/.local/bin/ateam
```

Make sure `~/.local/bin` is on the PATH of a **login** shell (most distros add it in
`~/.profile`). The desktop invokes the box as `bash -lc 'ateam …'`, so this is what
matters. Verify from your Mac:

```bash
ssh <box> "bash -lc 'ateam'"
# → usage: ateam <daemon | attach --stdio>
```

> Also install the agent CLIs you want to run on the box (e.g. `claude`) — the daemon
> only exposes agents that are installed and on its PATH.

## 2. Put the box on your tailnet

Install Tailscale on the box and bring it up:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Note the box's **tailnet IP** (`100.x.y.z`) or its MagicDNS name (`tailscale ip -4`).

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

## Troubleshooting

The connection menu surfaces the real error inline. Common ones:

| Symptom | Fix |
| --- | --- |
| **"No servers in ~/.ssh/config"** in the menu | Add a `Host` entry (step 3). |
| Connect hangs or fails | Check `ssh <box>` works, Tailscale is up on **both** ends (`tailscale status`), and `ateam` is on the box's login PATH: `ssh <box> "bash -lc 'command -v ateam'"`. |
| **"Protocol mismatch"** | The Mac app and box server are different versions — rebuild & redeploy the box dist (step 1), or update the desktop app, so both speak the same protocol. |
| Board is empty after connecting | The box has no registered projects yet — add one from the box's filesystem via **Add project** (or register a repo path on the box). |

## Notes

- **Nothing is exposed publicly.** The box is reachable only over your tailnet; there
  are no open ports and no inbound firewall rules to manage.
- **The same box also backs the iOS app** — the phone connects to the daemon over a
  WebSocket (`ATEAM_WS_ADDR`) instead of SSH, but it's the same daemon, agents, and
  worktrees. Both transports ride Tailscale.
- **Sessions persist.** The daemon keeps agents and PTYs alive across disconnects;
  reconnecting re-attaches to the exact running sessions.
