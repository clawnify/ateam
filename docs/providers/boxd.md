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
`gh` API rather than git. Provisioning a project onto the box no longer requires
it (since v0.1.42): the engine's clone falls back from `gh` to plain `git clone`,
which rides boxd's credential helper, so a bare box with only the GitHub
integration connected can clone. `gh` itself never gets the integration's token
from the engine: boxd's image wires it in as a `gh` shell function in login shells
(`/etc/profile.d/boxd-github.sh`, fetching a token from boxd's metadata server for
each call), and the engine runs `gh` as a program, not through a shell. So the
engine's `gh repo clone` fails there and the plain `git clone` does the work.

**What the integration hands out** (measured 2026-10-25). Any process on the box gets
the integration's token with one `git credential fill`, and boxd's helper keeps a
copy in `/run/boxd/github-token` for 5 minutes. It's a classic OAuth token (`gho_`)
with `repo` and `user:email`, and GitHub reports no expiry for it. On the account we
measured it reached the account's own repos (61, private ones included) and two it
collaborates on, and none in an org whose policy keeps boxd's app out. So "no token
is stored inside the VM" holds for the disk and for snapshots, not for a running
agent, which can fetch the token and use it from anywhere until the integration is
disconnected.

For a box agents run on unattended, a [fine-grained token](sprites.md#github-credentials)
reaches less and expires. It only narrows access once the integration is gone,
because until then the box keeps handing the broader token to any process:

```bash
boxd manage integrations disconnect git     # listed as "Git" in `boxd manage integrations list`
pbpaste | ssh mybox.boxd 'gh auth login --with-token'
ssh mybox.boxd 'gh auth setup-git'
```

With the integration disconnected there's nothing of boxd's left for `gh auth
setup-git` to replace, so the warning above no longer applies.

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

A hibernated box takes `tailscaled` down with it, and **the phone's traffic does
not wake it**: the tailnet path goes straight to the VM, never through boxd's
proxy, which is the only thing that wakes a machine. See the next section for how
Ateam manages sleep. Traffic relays through DERP rather than a direct path (fine
for JSON-RPC, laggier for PTY output).

## Sleep and wake

The engine manages a boxd box's sleep itself: once no agent has
worked for `engine.idleSleepMinutes` (Settings → General, default 60, 0 never),
it lets boxd hibernate the box, and it wakes the box for the next loop tick or
task reminder (a wait coming due). The
box keeps every process and session; it bills disk only while asleep, against
about €61 a month for a 2 vCPU box left running (boxd pricing, Oct 2026).

How it works, and why each piece is the way it is. Every row was measured on real
boxes on 2026-10-21:

| Behaviour | Measured |
|---|---|
| Inbound SSH through boxd wakes a hibernated box | Woke and answered in 3.0s |
| boxd's API with an API key (`GetVm`, `WakeVm`), what Ateam Go does | Hibernated to running in 1.5s, sign-in included; the tailnet answered 1.6s later |
| Tailnet traffic to a hibernated or standby box | No reply; the box stays asleep |
| HTTPS to `*.boxd.sh` | `503` (bot protection); the box stays asleep |
| An idle SSH session with keepalives | Does not keep the box awake |
| `tailscaled` on the box | Keeps it awake forever while outbound traffic counts |
| `idle.ignore-outbound on` with that `tailscaled` | Hibernated within 80s of a 60s timeout |
| A `run` job (`every(...)`) on a box boxd hibernated itself | boxd woke it ~30s early; the job fired on time |
| The same job on a box hibernated with `boxd machine hibernate` | Not woken; the job fired once, late, on the next wake |
| A Node timer due while the box slept | Fires the moment the box wakes (the clock keeps counting) |
| A process running at hibernation | Still running after the wake |
| `auto-suspend.timeout 60` with the hibernate timer off (2026-10-25) | Suspended (`standby`) 70s after the last connection: a hold that only stops hibernation doesn't stop this |
| Both timers off, the engine's hold (2026-10-25) | Still running 3.5 minutes after the last connection |
| Suspend off, hibernate 60s, the engine's release (2026-10-25) | Hibernated 76s after the last connection |

When to sleep is decided by the engine for every provider
(`packages/server/src/sleep/control.ts`); this is how its boxd driver
(`sleep/boxd.ts`) carries that out. It never hibernates the box itself, because a
box hibernated on command is not woken for its jobs. It steers boxd's own timer
instead:

- **Both** turn boxd's other idle timer off (`auto-suspend.timeout 0`). It's off on
  a new machine, but when on it suspends a held box under a working agent, and a
  released one would suspend instead of hibernating, which is not the state loops
  were measured waking from.
- **Hold** (`auto-hibernate.timeout 0`) while an agent is working, for the idle
  window after, and for a fresh window whenever a client attaches. An idle
  connection is not traffic boxd counts, so without this a box woken to start a
  task would fall asleep under you.
- **Release** (`idle.ignore-outbound on`, `auto-hibernate.timeout 60`) once idle.
  Ignoring outbound is what lets a box with `tailscaled`, a worktree sweep and git
  fetches go quiet at all; only a connection opened to the box keeps it up.
- Before releasing, the engine registers a one-minute `run` job for the next loop
  tick or wait, whichever is sooner (`~/.ateam/boxd/loop-wake.run.ts`), which boxd
  wakes the box for. A box
  whose image has no `run` (one created 2026-08-04 had none; one created
  2026-10-21 did) stays held while it has a live loop, because a loop that
  silently never runs is worse than a box that stays up.

What wakes a sleeping box: connecting from the desktop (picking it, or starting a
task there), `boxd machine wake <vm>`, a loop tick, or a wait coming due. The desktop leaves a box it
finds hibernated at launch asleep, labelled "asleep, wakes when you use it",
instead of waking every box each time the app starts (it asks `boxd machine list`,
which wakes nothing).

The phone can't wake a box over the tailnet, so Ateam Go asks boxd's API instead:
on its connection screen, set **Provider** to boxd and enter the machine's boxd
name and a boxd API key. Saving the key checks it with boxd at once, and
connecting (or opening the app, or coming back to it) checks the machine's state
and wakes it first. A box it woke gets up to three minutes to answer, with each
step shown under the box's card. While a dropped connection retries, the phone
checks again whenever its last wake is over a minute old.
The key lives in the iOS Keychain and is shared by every boxd box on the phone.
boxd keys can't be limited to waking or to one machine; a key acts on its whole
boxd org, so keep your Ateam boxes in an org of their own and give the phone that
org's key (`boxd auth keys create <name> --org <org>` on a current CLI).

Two more things measured along the way:

- **The box's clock is not synchronised.** `timedatectl` reports `NTP service:
  inactive`, and one box ran 110s behind after weeks of hibernating. A cron loop
  fires that much late. A freshly created box was exact.
- **Only the in-VM CLI knows `idle.ignore-outbound`.** The laptop CLI at 0.2.10
  rejects it; inside the box it applies to the machine it runs on.

## Gotchas

- **On a box created from boxd's current image, older engines don't start at all.**
  The image ships Node v24.21.0, and engines up to v0.1.65 abort at startup with
  `Assertion failed: (env) != nullptr` (from better-sqlite3 11.x), before logging
  anything: `~/.ateam/daemon.log` holds only a native stack, and the installer's
  handshake reports `<no reply>`. Later engines pin better-sqlite3 13, which starts
  fine there (measured 2026-10-23). A box on Node 24.18.0 was unaffected.
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
- **Every machine has a public HTTPS route.** `https://<name>.boxd.sh` forwards to
  port `auto` by default, which serves the first of 80, 443, 8080, 8000, 3000 or
  5173 that is listening: behind boxd's bot protection, but with no login. So an
  agent's dev server is on the internet the moment it starts. Ateam doesn't use the
  route (previews go over Tailscale), so point it at a port nothing uses:
  `boxd machine proxy set-port --vm <name> --port 1` (`--port auto` undoes it).
- **A hibernated box looks like a Tailscale failure.** An idle machine hibernates by
  default and its tailnet node goes `offline, last seen …`; the node is fine and its
  key hasn't expired — there's simply no host running. `boxd machine wake <vm>` brings
  it back, keeping its state and the *same* tailnet IP, and systemd restarts the
  engine. See "Sleep and wake" for how the engine manages it.
- **`boxd snapshots save`**, not `create`.
