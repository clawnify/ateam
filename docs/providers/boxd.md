# boxd

<a href="https://boxd.sh"><img src="../../assets/boxd.png" alt="boxd" width="99" /></a>

> Placeholder logo: this is a raster wordmark, not the square SVG
> (`assets/providers/boxd.svg`) that [the contribution rules](README.md#the-logo)
> require. Needs a 1:1 SVG from boxd.

[boxd](https://boxd.sh) rents persistent Linux microVMs — KVM, own kernel, real
root — that boot in milliseconds and fork in ~160ms carrying disk, memory and
running processes. The images already ship `git`, `gh`, `node`, `docker` and
`claude`, so there's no user, firewall or Tailscale setup to do. Unlike a VPS, the
box is reached over boxd's own authenticated SSH proxy rather than your tailnet.

**Verified against** Ateam v0.1.39 · boxd CLI 0.2.5 · 2026-08-12

## Create a box

```bash
curl -fsSL https://boxd.sh/downloads/install.sh | sh
boxd auth login
boxd new mybox
```

boxd writes the `mybox.boxd` host alias — hostname, port and key — straight into
your `~/.ssh/config`, so `ssh mybox.boxd` works immediately and the box appears in
Ateam's connection switcher with nothing else to configure.

Note the installer also drops `boxd-*` skills into `~/.claude/skills`, wires them
into Codex and OpenCode, and enables zsh completion.

## What's preinstalled

`git`, `gh`, `node`, `npm`, `docker`, `claude`, `codex`.

**Not** present, and worth knowing: `tailscale`, and — surprisingly — **`sshd`**.
Nothing listens on port 22 inside the VM; boxd terminates SSH at its proxy.

## GitHub credentials

Connect once on your Mac, not per box:

```bash
boxd manage integrations connect github
```

boxd's images ship a git credential helper wired at **system scope** in
`/etc/gitconfig` (`helper = boxd`, backed by `/usr/local/bin/boxd-github-token`),
plus a `url.insteadOf` rewrite so `git@github.com:` remotes go through it too. The
helper fetches the token on demand, so **no token is stored inside the VM** — which
means snapshots and forks get working git access without inheriting a credential.
Disconnecting revokes it centrally.

**Don't run `gh auth setup-git` on a boxd box.** It writes a *global* helper and
emits an empty `helper =` first, which resets the inherited chain — silently
replacing boxd's mechanism with gh's. If it's already been run:

```bash
git config --global --unset-all credential.https://github.com.helper
```

Still run `gh auth login`: Ateam's PR and merge-queue operations go through the
`gh` API rather than git.

## Install the engine

```bash
ssh mybox.boxd 'git config --global user.name "you" && git config --global user.email "you@example.com"'
ssh -t mybox.boxd 'gh auth login'      # device code — works over SSH
ssh -t mybox.boxd claude               # preinstalled; log in once, then exit

ssh mybox.boxd 'curl -fsSL https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh | bash'
```

The readiness report ends with `[--] tailscale`. That one is expected — boxd
provides the private path itself.

## Connect

Pick **`mybox.boxd`** in the connection switcher.

boxd registers more than one alias per machine (`mybox.boxd`, `mybox.boxd.sh`,
plus a shared `boxd.sh` defaults entry). Ateam collapses aliases that reach the
same engine, so you should see one entry — but if you're on an older build you'll
see all three, and `boxd.sh` is not a machine.

## iOS

The phone reaches a box over a WebSocket on your tailnet, and a boxd VM **can't run
`tailscaled` normally**: the kernel is monolithic with no TUN device (`/lib/modules`
is empty and loading `tun` fails). boxd is building a proxy-based Tailscale
integration — proxy nodes join *your* tailnet and route to your VMs — which will
make this automatic. Until that ships, it works via Tailscale's
**userspace-networking** mode, which needs no TUN:

```bash
# on the box
curl -fsSL https://tailscale.com/install.sh | sh
sudo sed -i 's|^FLAGS=.*|FLAGS="--tun=userspace-networking"|' /etc/default/tailscaled
sudo systemctl restart tailscaled
sudo tailscale up --hostname=mybox        # prints a sign-in URL

# keep the engine on loopback and let Tailscale bridge to it
sudo loginctl enable-linger "$USER"
ATEAM_WS_ADDR=127.0.0.1:8787 \
  curl -fsSL https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh | bash -s -- --service
sudo tailscale serve --bg --tcp 8787 tcp://localhost:8787
```

Then point the phone at `<tailnet-ip>:8787`. The engine only ever binds loopback,
so it's reachable from your tailnet and nowhere else — the same posture as a VPS.

Two caveats: traffic relays through DERP rather than a direct path (fine for
JSON-RPC, laggier for PTY output), and this is manual per box.

## Gotchas

- **`RPC connection closed` is not a credential error.** A missing credential fails
  fast and loudly with `could not read Username for 'https://github.com'`, and
  public repos clone with no credentials at all. If provisioning drops the
  connection, the desktop app is out of date relative to the box's protocol
  version.
- **`boxd env set` defaults to `--scope shared`** — the org's shared VMs. Pass
  `--scope private` deliberately.
- **Snapshots capture memory + disk**, including Ateam's engine database at
  `~/.ateam/ateam.sqlite`. Ateam routes by globally-unique ids, so forks sharing a
  database silently mis-route git operations and hide one fork's tasks. Delete it
  before `boxd snapshots save`, and log `gh` out first — forks inherit credentials
  too.
- **`boxd snapshots save`**, not `create`.
