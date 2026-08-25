# boxd

<a href="https://boxd.sh"><img src="../../assets/providers/boxd.svg" alt="boxd" width="48" /></a>

[boxd](https://boxd.sh) rents persistent Linux microVMs — KVM, own kernel, real
root — that boot in milliseconds and fork in ~160ms carrying disk, memory and
running processes. The images already ship `git`, `gh`, `node`, `docker` and
`claude`, so there's no user, firewall or Tailscale setup to do. Unlike a VPS, the
box is reached over boxd's own authenticated SSH proxy rather than your tailnet.

**Verified against** Ateam v0.1.39 · boxd CLI 0.2.10 · 2026-08-25

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

## Tailscale integration (org-level, shipped)

boxd's proxy-based Tailscale integration has shipped
([guide](https://docs.boxd.sh/guides/tailscale.md)). It works at the **edge**, not
per VM: boxd's edge servers enrol as `boxd-proxy-*` devices in *your* tailnet, and
every `*.boxd.sh` hostname you own — HTTPS, subdomain proxies, SSH aliases, raw
port forwards — resolves only to tailnet addresses and routes through those nodes.
Same hostnames, same TLS, nothing to install inside any VM. A personal Tailscale
account works fine; "org" means your boxd org.

Onboarding is not self-service:

1. Email `contact@boxd.sh` with your boxd org name and a Tailscale auth key
   (reusable, non-ephemeral, no tags) from your own admin console.
2. Approve the `boxd-proxy-*` devices that appear in your tailnet and disable key
   expiry on each (they otherwise expire after 180 days).
3. Use machines as before: `curl https://myapp.boxd.sh`, `ssh myapp.boxd`.

Caveats:

- **All-or-nothing for the boxd org.** Every machine's hostnames become reachable
  only from inside your tailnet — anything you shared publicly via a `*.boxd.sh`
  URL stops resolving for outsiders. The boxd API/CLI stays reachable from
  anywhere.
- Org wildcard domains follow onto the tailnet; per-machine apex domains can't
  (A-record conflict).
- The auth key you hand over expires (90 days max); an expired key blocks boxd
  from enrolling *new* edge capacity.
- Corporate DNS with rebinding protection may strip the `100.64.0.0/10` answers —
  use Tailscale's resolver.
- Because traffic now enters through boxd's edge — the same path that wakes a
  machine on inbound SSH/HTTPS — auto-hibernate should no longer strand the phone
  the way the in-VM setup below does. *Unverified: this org isn't enrolled yet;
  test wake-from-phone before relying on it.*

## iOS

The phone reaches a box over a WebSocket on your tailnet. With the edge
integration above enabled there is nothing to do per box — the engine's port is
already tailnet-reachable through boxd's proxy. Without it, note that a boxd VM
**can't run `tailscaled` normally**: the kernel is monolithic with no TUN device
(`/lib/modules` is empty and loading `tun` fails). The fallback — and what runs on
this org's boxes today — is Tailscale's **userspace-networking** mode, which needs
no TUN:

```bash
# on the box
curl -fsSL https://tailscale.com/install.sh | sh
sudo sed -i 's|^FLAGS=.*|FLAGS="--tun=userspace-networking"|' /etc/default/tailscaled
sudo systemctl restart tailscaled
sudo tailscale up --hostname=mybox        # prints a sign-in URL

# keep the engine on loopback and let Tailscale bridge to it
# (linger only matters if the installer falls back to a --user unit; with sudo
#  available here it writes a system unit, which needs no login session at all)
sudo loginctl enable-linger "$USER"
ATEAM_WS_ADDR=127.0.0.1:8787 \
  curl -fsSL https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh | bash -s -- --service
sudo tailscale serve --bg --tcp 8787 tcp://localhost:8787
```

Then point the phone at `<tailnet-ip>:8787`. The engine only ever binds loopback,
so it's reachable from your tailnet and nowhere else — the same posture as a VPS.

**Turn auto-hibernate off on any box the phone uses.** boxd cold-snapshots an idle
machine — the default is `auto_hibernate: 14400s`, four hours — which takes
`tailscaled` down with it, and **the phone cannot wake it**: waking needs the boxd
CLI or API, which the iOS app knows nothing about. Otherwise you open the app away
from your desk and find a dead endpoint with no way to revive it.

```bash
boxd machine config set mybox auto-hibernate.timeout 0   # 0 disables
```

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
- **A hibernated box looks like a Tailscale failure.** An idle machine hibernates by
  default and its tailnet node goes `offline, last seen …`; the node is fine and its
  key hasn't expired — there's simply no host running. `boxd machine wake <vm>` brings
  it back, keeping its state and the *same* tailnet IP, and systemd restarts the
  engine. See the iOS section for turning it off.
- **`boxd snapshots save`**, not `create`.
