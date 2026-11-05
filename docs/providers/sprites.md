# Sprites

<a href="https://sprites.dev"><img src="../../assets/providers/sprites.svg" alt="Sprites" width="48" /></a>

[Sprites](https://sprites.dev) are persistent Linux microVMs on [Fly.io](https://fly.io):
hardware-isolated, 8 vCPUs, a 100 GB disk that survives every sleep, and billed by
actual CPU and memory use while running. A Sprite pauses on its own a few seconds
after nothing is using it, and paused time isn't billed. An agent working inside
doesn't count as use, so the engine holds the Sprite awake while it is in use (an
agent working, typing in a terminal, the Lead chat) and lets it pause once nobody
has used it for a while. See [Sleeping](#sleeping).

**Verified against** Ateam v0.1.87 · sprite CLI 2026-10-20-hotfix.1 (2026-11-03 is
out, not run) · 2026-11-04. Run on a new Sprite: the SSH server, key and alias below,
Ateam's own install command over that alias (44 seconds), and the installer's
`--tailscale`, which ran Tailscale as a Sprite service in kernel mode, reached over the
tailnet by a client speaking Ateam Go's protocol. **Not run** this time: Ateam Go
itself, and sleeping and waking, measured 2026-10-24 with the engine from the release
after v0.1.66 ([Sleeping](#sleeping)).

> **Sleep and wake** needs an engine newer than v0.1.66 on the box, and Ateam Go newer
> than 1.2.0 for the phone to wake a paused Sprite. An older engine doesn't hold the
> Sprite, so an agent left working with no client attached is paused within seconds.

## Create a box

```bash
curl -fsSL https://sprites.dev/install.sh | sh    # installs to ~/.local/bin
sprite login                                        # Fly.io account, in the browser
sprite org auth                                     # if `sprite org list` shows no org
sprite create mybox
```

`sprite create` opens a console on the new Sprite and leaves it running; leave it with
`exit` (see [Gotchas](#gotchas)). The CLI writes **nothing** to `~/.ssh/config`, and a
Sprite has no SSH server, so Ateam can't see it until you give it both
([Install the engine](#install-the-engine)).

## What's preinstalled

In `sprite exec` and `sprite console`: `git`, `gh`, `node` (24), `npm`, `bun`, `python`,
`go`, `rust` and more in `/.sprite/bin`, and a dozen agent CLIs in `~/.local/bin`,
`claude`, `codex`, `gemini`, `copilot` and `cursor-agent` among them. You run as the
`sprite` user with passwordless `sudo`.

Over SSH, which is how Ateam reaches the box, a login shell has no `/.sprite/bin` on its
PATH. So the installer adds a Node 22 of its own (in `~/.nvm`) and a `gh` (in
`~/.local/bin`), and Ateam finds `claude` and `codex`.

**Not** present: `sshd`, `systemd`, `tailscale`, `docker`, `opencode`. Long-running
processes are Sprite *services* (`sprite-env services`), not systemd units.

**Claude Code is set to skip every permission check.** The image's
`~/.claude/settings.json` sets `"defaultMode": "bypassPermissions"`. Ateam starts
every Claude task with bypass turned off, so a task asks before it acts, or runs in
auto mode when you turn Auto on. A `claude` you start yourself, in a shell pane or
over SSH, still reads that default: delete the `defaultMode` line if you want it to
ask there too.

**The image sets a git identity of its own,** `Sprite <noreply@sprites.dev>`, which
credits commits to no one. Engines from Ateam 0.1.88 treat it as unset: connecting
GitHub replaces it with your account's, and until then the installer's readiness report
flags it. On an older engine, set your own:
`git config --global user.name "you"; git config --global user.email "you@example.com"`.

## GitHub credentials

Nothing is wired up: no credential helper, and `gh` isn't logged in. **Connect GitHub
from Ateam**, under GitHub on the box's page in **Settings → Boxes**, which opens after
Set up, with a
**fine-grained token** limited to what the box works on, rather than `gh auth login`.
Agents run here, and `gh auth login` hands them a token that never expires and reaches
every repo your account can, in plain text in `~/.config/gh/hosts.yml` (a Sprite has no
keyring) and in every checkpoint taken after it.

Ateam opens GitHub's form for the token with a 90-day expiry and these permissions
filled in; you pick the repositories and paste the token into Ateam, which hands it to
`gh` on the box:

| Permission | What Ateam does with it |
| --- | --- |
| Contents: read and write | clone, push, merge a PR |
| Pull requests: read and write | `gh pr view`, `gh pr create`, `gh pr merge` |
| Issues: read and write | list a project's issues, file one |
| Commit statuses: read | see CI that reports statuses, so the merge queue waits for it |

Workflows stays off: an agent that can edit `.github/workflows` can reach the repo's
Actions secrets. Fine-grained tokens can't call the Checks API, which Ateam doesn't use.
An org owner's own token is approved at once; anyone else's waits for an owner to
approve it.

Measured on a Sprite (2026-10-25): the engine's repo query listed only the org's
repos, plus public ones (every fine-grained token reads those); a private org repo
read fine; a push dry run to an org repo passed; and no private repo outside the org
was visible.

Sprites' GitHub [Connector](https://docs.fly.io/sprites/concepts/connectors.md)
doesn't replace that. It keeps the token out of the box by proxying GitHub's REST
API through `https://api.sprites.dev/v1/gateway/github/<connection-id>/…`, and that
part works, private org repos included. But it carries no git. The gateway forwards
to GitHub's API host, so a git path answers with the API's own 404
(`"documentation_url": "https://docs.github.com/rest"`) and `git ls-remote` against
it says `repository not found`; no OAuth scope changes that. It gives `gh` no token
either.
Ateam clones and pushes with git and opens PRs with `gh`, so the box still needs its
own login. Without one, **Add a project from GitHub** opens with no repos: Ateam
lists them with `gh api user/repos`, which answers `please run: gh auth login`, even
though the same query through the gateway returns them all.

Every Sprite also ships a `sprite-api-gateway` skill for Claude Code, Codex, Cursor
and Gemini, which calls the gateway "the only supported way to access external APIs
from a Sprite". With a connector set up, an agent on the box may use it for GitHub
API calls instead of `gh`.

## Install the engine

A Sprite needs an SSH server and a key before Ateam can reach it. Run these once:

1. An SSH server, as a Sprite service. `/run` is emptied on every boot, so the command
   recreates sshd's directory each time:

   ```bash
   sprite exec -s mybox -- bash -lc 'sudo apt-get install -y openssh-server && sprite-env services create sshd --no-stream --cmd sudo --args "bash,-c,mkdir -p /run/sshd && exec /usr/sbin/sshd -D -e"'
   ```

2. A key without a passphrase (Ateam connects with `BatchMode=yes`, so it can't
   prompt for one), authorized on the Sprite. On your Mac:

   ```bash
   ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519_sprites
   sprite exec -s mybox -- bash -c "mkdir -p ~/.ssh && echo '$(cat ~/.ssh/id_ed25519_sprites.pub)' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
   ```

3. An alias in `~/.ssh/config`, going through the Sprites proxy:

   ```sshconfig
   Host mybox.sprite
     HostName mybox
     User sprite
     IdentityFile ~/.ssh/id_ed25519_sprites
     IdentitiesOnly yes
     ProxyCommand ~/.local/bin/sprite proxy -o <your-org> -s %h -W :22
   ```

   `ssh mybox.sprite` should now land you in the box.

Then pick **`mybox.sprite`** in Ateam: New task → **Run on** lists it as not set up yet,
or use **Settings → Boxes → Add a box → Set up a box over SSH**. Ateam installs the
engine over SSH, as the Sprite service described below, and connects. Log into an agent
once (`ssh -t mybox.sprite claude`) as on any other box.

By hand instead, the same install Ateam runs:

```bash
ssh mybox.sprite 'curl -fsSL https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh | bash -s -- --service'
```

### The engine's service

**Don't stop, restart or delete the `ateam` service while agents run.** Measured on
a Sprite: sprite-env kills every process a service started, `setsid` ones included,
when it stops, restarts or deletes the service, and when it restarts it after its
process exits (at once after exit 0, with backoff otherwise). The PTY daemon holding
every agent session is one of those processes.

So the service the installer creates is a keeper loop rather than the engine itself:
when the engine stops, for an upgrade or a crash, the loop starts it again from the
installed version a second later, and the service never restarts. Upgrades from the
desktop or the phone use it the same way. A service made before the keeper existed
(`exec ateam daemon`) is moved to it the next time the installer runs with no agent
running; while agents run, the installer leaves it alone and says so.

## Connect

Pick **`mybox.sprite`** in the connection switcher. Connecting wakes the Sprite if it
was paused: about 2s from cold.

## iOS

The phone reaches a Sprite over Tailscale. **Set up phone access**, under Access on the
box's page in Settings → Boxes (Ateam 0.1.88 or later), does it: Ateam runs the installer
again with `--tailscale`, which installs Tailscale, runs it as a Sprite service (so it
starts when the Sprite boots), joins the Sprite to your tailnet and opens the engine's
network port on its tailnet address. Your browser opens Tailscale's page to approve the
Sprite: press **Connect** at the end of it. Then add the Sprite in Ateam Go at the address
the page shows, on an iPhone signed in to the same Tailscale account. The
[recipe](README.md) has the rest: no Tailscale account yet, and key expiry. From a
terminal, the same thing:

```bash
ssh mybox.sprite 'curl -fsSL https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh | bash -s -- --tailscale'
```

It prints the link to approve the Sprite with, waits up to 15 minutes for you, and ends
with the address for Ateam Go (`Ateam Go reaches it at 100.x.y.z:8787`). With
`TS_AUTHKEY=<key>` before `bash` it joins without a link; a key made with a tag keeps
the Sprite on the tailnet for good, while a device approved from a link drops off after
180 days unless you turn key expiry off for it. The address is kept in
`~/.ateam/ws-addr`, which the engine reads however it was started, and later upgrades
keep it. The engine keeps retrying its port until Tailscale has the address, so it
doesn't need to wait for `tailscaled`.

A paused Sprite doesn't answer on the tailnet, so on the phone's connection screen set
**Provider** to **Sprites** and enter the Sprite's name and a Sprites API token: create
one at [sprites.dev/account](https://sprites.dev/account) and paste the whole `my-org/…`
string. A Sprite added by its address alone (a pairing code, or the IP typed in) fills
in the provider and its name itself the first time the phone reaches it awake: the
engine says it runs on a Sprite, and which one (its hostname is its name). The token
is still yours to add; tapping a Sprite the phone has no token for opens its form at
the token, rather than dialling it asleep until it times out. A box with no provider
that doesn't answer (one on an engine from before this, say) says so under its card,
with a **Set provider** button. A Sprite whose idle sleep is off says it's always on, and
the phone then never shows it asleep or asks for a token. Before connecting, the phone asks Sprites to wake the Sprite and hold it
for five minutes, then keeps trying the Sprite for up to three: a Sprite reported
awake can take a while longer to answer. Once the phone attaches, the engine holds
it for a fresh idle window, as for any client connecting to a box it had let go.
It wakes when you use it: Connect, tapping its card, opening one of its tasks,
starting a task there, its terminal or the Lead on it. Opening the app doesn't, so a
paused Sprite stays paused, its tasks shown as the phone last saw them, until you
use it. While a dropped connection retries with one of its tasks or its terminal
open, it wakes again whenever the last wake is over a minute old, so a Sprite that
paused again before the phone got through is not left asleep. A
Sprites token works on every Sprite in its organization, so give the phone one for
an organization that holds only your Ateam boxes. Until the Sprite is locked to your
devices, anyone on your tailnet can use its network port: lock it under Access on
the Sprite's page.

What we measured (2026-10-24):

| | |
| --- | --- |
| tailscaled running, nothing attached | Still paused within seconds. Unlike [boxd](boxd.md), Tailscale doesn't keep the box up |
| Phone-style WebSocket to a paused Sprite | Timed out; the Sprite stayed paused |
| Tailnet back after a wake | About 6s while a hold kept the Sprite up. Without a hold it went back to sleep first: no answer in the ~20s it stayed awake |
| An idle WebSocket open over the tailnet | Doesn't count as activity: the Sprite paused under it when the hold ran out |
| The phone's wake, Sprite paused | Woken and held in 2.5s; the tailnet answered 4.8s after the call |
| The phone attached | The engine took its own hold the same second, beside the phone's |

## Sleeping

What we measured on one Sprite, with the engine installed as above:

| | |
| --- | --- |
| Nothing attached, engine running | Paused about 10s after the last session ended |
| Engine and sshd running as services | Still paused: a quiet service doesn't count as activity |
| An idle SSH connection open (the desktop's path) | Stayed awake |
| Paused a few minutes, then woken | Engine and its PTY daemon (which owns the agents) still running |
| Stopped (after a longer sleep, or a restart) | Only services come back: the engine does, agents and their sessions don't |
| A [task hold](https://docs.fly.io/sprites/keeping-sprites-running.md) of 2 minutes | Stayed awake exactly until it expired, then paused at once |
| The engine, its idle window (set to 1 minute) over | Deleted its hold at the minute; the Sprite paused the same second |
| Woken again by anything | The engine holds it for a fresh idle window, as on every provider |

So without a hold, an agent is paused mid-turn seconds after you detach. The engine
holds the Sprite with a task (`ateam-engine`, on the Sprite's own API socket) while
it is in use, renews it every few minutes, and deletes it once nobody has used it
for the idle window (**Settings**, an hour by default). In use, and what restarts
the window, are the same on every provider: see
[Sleep and wake](README.md#sleep-and-wake). Fly
pauses the Sprite as soon as nothing else is going on.

A connected desktop keeps a Sprite awake by itself: Fly counts its SSH connection as
activity.

Two limits are Fly's:

- **No scheduler.** A paused Sprite can't wake itself, so the engine keeps a Sprite
  with a loop on held (awake, and billed for what it uses) rather than let the loop
  miss its tick. A task waiting on a date does not hold it: a wait can be days
  away. A paused Sprite files the card when it next wakes, so the board and the
  Mac's notification come late, while Ateam Go still rings on time if it saw the
  wait before the Sprite paused.
- **Restarts that lose recent writes.** Sprites on the `sbd` storage driver (check
  `echo $SPRITE_STORAGE_DRIVER`) can restart on their own a minute or two after
  waking, losing about the last minute of disk writes
  ([open thread](https://community.fly.io/t/sprite-restarts-by-itself-1-to-3-minutes-after-waking-from-idle-reproducible-sbd-storage/28796)).
  Ours did, twice in an hour. For Ateam that's the engine's database.

## Gotchas

- **An open `sprite console` keeps the Sprite awake** while its prompt produces
  output, and it's easy to forget one: `sprite create` opens a console and leaves it
  running. `sprite sessions list` shows them; `sprite sessions kill <id>` closes one.
- **The status Sprites reports lags** (`sprite info`, `sprite list`, the API). It said
  `cold` for a Sprite running a command. Ateam reads it only to skip connecting to a
  sleeping Sprite over SSH, at launch and when the desktop retries a dropped one,
  where a wrong `cold` costs little: the next retry, or using the Sprite, connects it.
- **`sprite proxy --ssh` refuses keys.** The built-in SSH emulation answered
  `Permission denied (publickey)` for every key we tried, including the one sshd
  accepted. Use a real sshd and `-W :22` as above.
- **A key with a passphrase fails without saying why.** sshd logs `Accepted key`,
  then the login fails with `Permission denied (publickey,password)`, because the
  client can't sign without prompting. Use a key with no passphrase, or load it into
  `ssh-agent`.
- **`pkill -f` inside `sprite exec -- bash -c '…'`** matches the exec's own command
  line and kills it, silently skipping the rest of the command.
