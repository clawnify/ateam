# boxd

<a href="https://boxd.sh"><img src="../../assets/providers/boxd.svg" alt="boxd" width="48" /></a>

[boxd](https://boxd.sh) rents persistent Linux microVMs (KVM, own kernel, real root)
that boot in milliseconds and fork in about 160ms, carrying disk, memory and running
processes. The image already ships `git`, `gh`, `node`, `docker` and three agent CLIs,
so there's no user or firewall to set up. Ateam reaches the box over boxd's own
authenticated SSH proxy; it joins your tailnet only for Ateam Go.

**Verified against** Ateam v0.1.87 · boxd CLI 0.2.10 (0.3.0 is out, not run) ·
2026-11-04. Run end to end on a new machine: creating it, setting it up from Settings →
Boxes with nothing typed on the box, and the installer's `--tailscale` in kernel mode
and, with the TUN device hidden, in userspace mode, each reached over the tailnet by a
client speaking Ateam Go's protocol. **Not run:** Ateam Go itself, boxd's GitHub
integration (this org has none connected), and boxd's org-level Tailscale integration.

## Create a box

```bash
curl -fsSL https://boxd.sh/downloads/install.sh | sh
boxd auth login
boxd new mybox
```

boxd keeps its own block in `~/.ssh/config`: a `Host *.boxd *.boxd.sh boxd.sh`
defaults entry, which Ateam skips because it holds patterns, and one `Host mybox.boxd
mybox.boxd.sh` entry per machine with its hostname, port and key. So `ssh mybox.boxd`
works at once, and Ateam lists the machine as `mybox.boxd`.

boxd's installer also offers agent skills (`boxd-*` in `~/.claude/skills`, wired into
Codex and OpenCode), a PATH line and zsh completion. It asks first, and with no terminal
to ask on it installs only the binary.

## What's preinstalled

On a machine created 2026-11-04 (Ubuntu 24.04, 2 vCPU, 8 GB, Node 24.22): `git`, `gh`,
`node`, `npm`, `bun`, `go`, `python3`, `docker`, and the agent CLIs `claude`, `codex`
and `opencode`.

**Not** there: `tailscale`, which `--tailscale` installs, and an SSH server listening in
the VM. Nothing answers on port 22; boxd ends SSH at its proxy. `/dev/net/tun` is there,
so Tailscale runs in its normal kernel mode. Older boxd images had no TUN device; on one
of those the installer runs Tailscale in userspace mode by itself.

## GitHub credentials

**Connect GitHub from Ateam**, under GitHub on the box's page in **Settings → Boxes**, which opens after
Set up. Ateam opens GitHub's form for a fine-grained token with its name, 90 days and
the permissions it uses filled in (they're listed in
[Sprites](sprites.md#github-credentials)); you pick the repositories this box works on
and paste the token into Ateam. It goes to `gh` on the box only, and the box's git
identity then sets itself from the account.

boxd has a GitHub integration of its own, which you connect once on your Mac
(`boxd manage integrations connect github`). It wires a git credential helper into the
image at **system scope** in `/etc/gitconfig` (`helper = boxd`, backed by
`/usr/local/bin/boxd-github-token`), plus a `url.insteadOf` rewrite so `git@github.com:`
remotes go through it too. The helper fetches the token on demand, so **no token is
stored inside the VM**: snapshots and forks get working git access without inheriting a
credential, and disconnecting revokes it centrally. When it's connected, Ateam leaves
that helper in charge of git and gives a token you connect to `gh` alone, since Ateam's
pull requests and merges go through `gh`.

**Don't run `gh auth setup-git` on a box with the integration.** It writes a *global*
helper and emits an empty `helper =` first, which resets the inherited chain and
silently replaces boxd's mechanism with gh's. If it's already been run:

```bash
git config --global --unset-all credential.https://github.com.helper
```

**What the integration hands out** (measured 2026-10-25). Any process on the box gets
the integration's token with one `git credential fill`, and boxd's helper keeps a copy
in `/run/boxd/github-token` for 5 minutes. It's a classic OAuth token (`gho_`) with
`repo` and `user:email`, and GitHub reports no expiry for it. On the account we measured
it reached the account's own repos (61, private ones included) and two it collaborates
on, and none in an org whose policy keeps boxd's app out. So "no token is stored inside
the VM" holds for the disk and for snapshots, not for a running agent, which can fetch
the token and use it from anywhere until the integration is disconnected. A fine-grained
token narrows that only once the integration is gone
(`boxd manage integrations disconnect git`; it's listed as "Git" in
`boxd manage integrations list`).

## Install the engine

Pick **`mybox.boxd`** in Ateam: New task → **Run on** lists it as not set up yet, or use
**Settings → Boxes → Add a box → Set up a box over SSH**. Ateam installs the engine over
SSH as a system service and connects. On a new machine that took about a minute
(2026-11-04), with nothing to type on the box. Then log into an agent once:

```bash
ssh -t mybox.boxd claude          # preinstalled; log in, then exit
```

By hand instead, the same install Ateam runs:

```bash
ssh mybox.boxd 'curl -fsSL https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh | bash -s -- --service'
```

## Connect

Pick **`mybox.boxd`**. A box set up from Ateam is connected already, and stays listed in
Settings → Boxes.

## iOS

The phone reaches a box over a WebSocket on your tailnet. **Set up phone access**, under
Access on the box's page in Settings → Boxes (Ateam 0.1.88 or later), does it: Ateam runs
the installer again with `--tailscale`, which installs Tailscale, joins the box to your
tailnet and opens its network port there. Your browser opens Tailscale's page to approve
the box: press **Connect** at the end of it. Then add the box in Ateam Go at the address
the page shows, on an iPhone signed in to the same Tailscale account. The
[recipe](README.md) has the rest: no Tailscale account yet, and key expiry. From a
terminal, the same thing:

```bash
ssh mybox.boxd 'curl -fsSL https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh | bash -s -- --tailscale'
```

It prints the link to approve the box with, and waits up to 15 minutes for you. With
`TS_AUTHKEY=<key>` before `bash` it joins without a link; a key made with a tag keeps the
box on the tailnet for good, while a device approved from a link drops off after 180
days unless you turn key expiry off for it. The installer ends with the address for Ateam
Go (`Ateam Go reaches it at 100.x.y.z:8787`). On a box with no TUN device it runs
Tailscale in userspace mode, keeps the engine on `127.0.0.1` and has Tailscale Serve
forward the port, which the engine reports as its address.

The tailnet path goes straight to the VM, never through boxd's proxy, so the phone's
traffic doesn't wake a hibernated box: Ateam Go wakes it through boxd's API (see
[Sleep and wake](#sleep-and-wake)). Until a box is locked to your devices, anyone on your tailnet can use its
network port: lock it under Access on
the box's page.

### boxd's Tailscale integration (org-level)

boxd's proxy-based Tailscale integration ([guide](https://docs.boxd.sh/guides/tailscale.md))
works at the **edge**, not per VM: boxd's edge servers enrol as `boxd-proxy-*` devices in
*your* tailnet, and every `*.boxd.sh` hostname you own (HTTPS, subdomain proxies, SSH
aliases, raw port forwards) resolves only to tailnet addresses and routes through those
nodes. Nothing is installed inside any VM. A personal Tailscale account works; "org"
means your boxd org. Not run here: this org isn't enrolled.

Onboarding is not self-service:

1. Email `contact@boxd.sh` with your boxd org name and a Tailscale auth key
   (reusable, non-ephemeral, no tags) from your own admin console.
2. Approve the `boxd-proxy-*` devices that appear in your tailnet and disable key
   expiry on each (they otherwise expire after 180 days).
3. Use machines as before: `curl https://myapp.boxd.sh`, `ssh myapp.boxd`.

Caveats:

- **All-or-nothing for the boxd org.** Every machine's hostnames become reachable
  only from inside your tailnet; anything you shared publicly via a `*.boxd.sh`
  URL stops resolving for outsiders. The boxd API and CLI stay reachable from
  anywhere.
- Org wildcard domains follow onto the tailnet; per-machine apex domains can't
  (A-record conflict).
- The auth key you hand over expires (90 days max); an expired key blocks boxd
  from enrolling *new* edge capacity.
- Corporate DNS with rebinding protection may strip the `100.64.0.0/10` answers:
  use Tailscale's resolver.
- Because traffic then enters through boxd's edge, the same path that wakes a
  machine on inbound SSH and HTTPS, the phone's traffic might wake a hibernated box
  where the per-VM tailnet path doesn't. *Unverified: test wake-from-phone before
  relying on it.*

## Sleep and wake

The engine manages a boxd box's sleep itself: once nobody has used the box
for `engine.idleSleepMinutes` (Settings → General, default 60, 0 never),
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
| The engine's idle window at 2 minutes, a client reconnecting every 30s to the held box, no work (2026-11-02) | Released when the window ran out, 22s after the last reconnect; hibernated within 70s of that |
| A client connecting by SSH 20s after it hibernated (2026-11-02) | Woke and answered in about 1s; the connection held it for a fresh window (too short a sleep to read as a wake) |
| Typing in the box shell every 50s for 4 minutes (2026-11-02) | Held throughout; released at the first check 2 minutes after the last keystroke (2m49s) |
| The Lead chat used every 50s for 4 minutes (2026-11-02) | Held throughout; released at the first check 2 minutes after the last use (2m14s) |
| Woken through boxd's API after 3 minutes asleep, nothing connecting (2026-11-02) | The engine read it as a wake and held it for a fresh window |

When to sleep is decided by the engine for every provider
(`packages/server/src/sleep/control.ts`); this is how its boxd driver
(`sleep/boxd.ts`) carries that out. It never hibernates the box itself, because a
box hibernated on command is not woken for its jobs. It steers boxd's own timer
instead:

- **Both** turn boxd's other idle timer off (`auto-suspend.timeout 0`). It's off on
  a new machine, but when on it suspends a held box under a working agent, and a
  released one would suspend instead of hibernating, which is not the state loops
  were measured waking from.
- **Hold** (`auto-hibernate.timeout 0`) while the box is in use, and for the idle
  window after. In use means an agent working, someone typing in one of its
  terminals (a box shell counts), or its Lead chat: mid-turn, or someone writing
  in it. A box that wakes gets a fresh window, and so does a client connecting to
  a released box: an idle connection is not traffic boxd counts, so without this
  a box woken to start a task would fall asleep under you. A client connecting to
  a box that is already held changes nothing, because the desktop reconnects on
  its own: a Mac asleep with its lid shut wakes for maintenance every 15 minutes
  or so, and when each reconnect restarted the window, a box with no work stayed
  up all night (2026-11-02).
- **Release** (`idle.ignore-outbound on`, `auto-hibernate.timeout 60`) once idle.
  Ignoring outbound is what lets a box with `tailscaled`, a worktree sweep and git
  fetches go quiet at all; only a connection opened to the box keeps it up.
- Before releasing, the engine registers a one-minute `run` job for the next loop
  tick or wait, whichever is sooner (`~/.ateam/boxd/loop-wake.run.ts`), which boxd
  wakes the box for. A box
  whose image has no `run` (one created 2026-08-04 had none; one created
  2026-10-21 did) stays held while it has a live loop, because a loop that
  silently never runs is worse than a box that stays up.

The engine's log says when it held or released the box and why, and once an
hour what keeps a held box up. Read it with `journalctl -u ateam` on the box when
the engine runs as the installer's service, or in `~/.ateam/daemon.log` when
`ateam attach` started it:

```
[ateam] 2026-11-02T00:20:41Z still holding boxd machine mybox awake: agent work at 2026-11-02T00:20:41Z
[ateam] 2026-11-02T01:21:00Z letting boxd machine mybox sleep: nothing for 60 min since typing in a terminal at 2026-11-02T00:20:13Z
[ateam] 2026-11-02T07:02:10Z holding boxd machine mybox awake: the box woke at 2026-11-02T07:02:10Z
```

What wakes a sleeping box: connecting from the desktop (picking it, or starting a
task there), `boxd machine wake <vm>`, a loop tick, or a wait coming due. The desktop leaves a box it
finds hibernated at launch asleep, labelled "asleep, wakes when you use it",
instead of waking every box each time the app starts (it asks `boxd machine list`,
which wakes nothing).

The phone can't wake a box over the tailnet, so Ateam Go asks boxd's API instead:
on its connection screen, set **Provider** to boxd and enter the machine's boxd
name and a boxd API key. A box added by its address alone fills in the provider and
the machine's name itself the first time the phone reaches it awake (the engine
says which machine it runs on); the key is still yours to add, and tapping a box the
phone has no key for opens its form at the key. A box with no provider that doesn't
answer says so under its card, with a **Set provider** button. A new box starts **always
on**: it never sleeps, needs no key, and is billed while up. Choose **Sleeps when idle**
in the box form on the phone or the desktop (right after the provider), or on its page in
Settings → Boxes; the key is then asked for. The choice is set on the box itself, never
synced from a Mac, and a box that ran Ateam before this keeps sleeping as it did until you
choose. boxd's own setting counts too: hibernation turned off in boxd after Ateam had let
the box sleep is kept, rather than undone at the next release. Saving the key checks it with boxd at once. Using the
box (tapping its card, opening one of its tasks, starting a task there, its
terminal or the Lead on it) checks the machine's state and wakes it first;
opening the app doesn't, so a hibernated box stays asleep, its tasks shown as the
phone last saw them, until you use it. A box it woke gets up to three minutes to
answer, with each step shown under the box's card. While a dropped connection
retries with one of its tasks or its terminal open, the phone checks again
whenever its last wake is over a minute old.
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
