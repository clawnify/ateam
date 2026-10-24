# Sprites

[Sprites](https://sprites.dev) are persistent Linux microVMs on [Fly.io](https://fly.io):
hardware-isolated, 8 vCPUs, a 100 GB disk that survives every sleep, and billed by
actual CPU and memory use while running. A Sprite pauses on its own a few seconds
after nothing is using it, and paused time isn't billed. That last part is what
makes it different from every other box here: **an agent left working on a Sprite
with no client attached gets paused too.** Read [Sleeping](#sleeping) before you
leave one working.

**Verified against** Ateam v0.1.66 · sprite CLI 2026-10-20-hotfix.1 · 2026-10-24

> **Sleep and wake support:** not yet. Ateam's engine can't hold a Sprite awake while
> an agent works, and nothing wakes a Sprite for a loop tick. See [Sleeping](#sleeping).

## Create a box

```bash
curl -fsSL https://sprites.dev/install.sh | sh    # installs to ~/.local/bin
sprite login                                        # Fly.io account, in the browser
sprite org auth                                     # if `sprite org list` shows no org
sprite create mybox
```

The CLI writes **nothing** to `~/.ssh/config`, and a Sprite has no SSH server, so
Ateam can't see it until you set both up ([Install the engine](#install-the-engine)).

## What's preinstalled

`git`, `gh`, `node` (24), `npm`, `bun`, `python`, `go`, `rust`, `claude`, `codex`.
You run as the `sprite` user with passwordless `sudo`.

**Not** present: `sshd`, `systemd`, `tailscale`, `docker`, `opencode`. Long-running
processes are Sprite *services* (`sprite-env services`), not systemd units.

## GitHub credentials

Nothing is wired up: no credential helper, and `gh` isn't logged in. Run
`gh auth login` on the box. Sprites also has
[Connectors](https://docs.fly.io/sprites/concepts/connectors.md), which keep a
GitHub token out of the box entirely. Ateam hasn't been tested with them.

**Set your own git identity.** Every Sprite ships a global one, `Sprite
<noreply@sprites.dev>`, and the installer's readiness check reports it as `[ok]`.
Commits made there are credited to "Sprite" unless you replace it.

## Install the engine

Every command here runs on the box with `sprite exec -s mybox -- bash -lc '…'`, or
in a `sprite console -s mybox`.

1. The engine, from the usual installer:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh | bash
   ```

   The readiness report ends with `[--] tailscale`; that's expected here.

2. Run the engine as a Sprite service, so it starts again after the box is stopped:

   ```bash
   sprite-env services create ateam --cmd bash --args "-lc,exec ateam daemon"
   ```

3. An SSH server, also as a service. `/run` is emptied on every boot, so the command
   recreates sshd's directory each time:

   ```bash
   sudo apt-get install -y openssh-server
   sprite-env services create sshd --cmd sudo \
     --args "bash,-c,mkdir -p /run/sshd && exec /usr/sbin/sshd -D -e"
   ```

4. A key without a passphrase (Ateam connects with `BatchMode=yes`, so it can't
   prompt for one). On your Mac:

   ```bash
   ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519_sprites
   sprite exec -s mybox -- bash -c "mkdir -p ~/.ssh && echo '$(cat ~/.ssh/id_ed25519_sprites.pub)' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
   ```

5. An alias in `~/.ssh/config`, going through the Sprites proxy:

   ```sshconfig
   Host mybox.sprite
     HostName mybox
     User sprite
     IdentityFile ~/.ssh/id_ed25519_sprites
     IdentitiesOnly yes
     ProxyCommand ~/.local/bin/sprite proxy -o <your-org> -s %h -W :22
   ```

   `ssh mybox.sprite` should now land you in the box.

Then log into an agent once (`ssh -t mybox.sprite claude`) as on any other box.

## Connect

Pick **`mybox.sprite`** in the connection switcher. Connecting wakes the Sprite if it
was paused: about 2s from cold.

## iOS

The phone reaches a Sprite over Tailscale, but only while something else keeps the
Sprite awake. It can't wake one, and an open phone connection doesn't keep it awake.

Tailscale runs in its normal kernel mode (`/dev/net/tun` is there), as a service:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sprite-env services create tailscaled --cmd sudo \
  --args "/usr/sbin/tailscaled,--state=/var/lib/tailscale/tailscaled.state,--socket=/run/tailscale/tailscaled.sock"
sudo tailscale up --hostname=mybox    # approve the printed URL
```

Then give the engine its phone port on the Sprite's tailnet IP (`tailscale ip -4`),
by recreating its service:

```bash
sprite-env services delete ateam
sprite-env services create ateam --cmd bash --args "-lc,exec ateam daemon" \
  --env ATEAM_WS_ADDR=<tailnet-ip>:8787 --needs tailscaled
```

What we measured:

| | |
| --- | --- |
| tailscaled running, nothing attached | Still paused within seconds. Unlike [boxd](boxd.md), Tailscale doesn't keep the box up |
| Phone-style WebSocket to a paused Sprite | Timed out; the Sprite stayed paused |
| Tailnet back after a wake | About 6s, longer than a Sprite stays awake on its own, so a wake needs a hold |
| An idle WebSocket open over the tailnet | Doesn't count as activity: the Sprite paused under it when the hold ran out |

So the phone needs two things Ateam doesn't have for Sprites yet: a wake through the
Sprites API that also takes a short hold, and an engine that holds the Sprite while
a client is connected. Until then, use the phone while the desktop is attached.

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

So on a Sprite, an agent keeps working while the desktop is attached. Detach, and it's
paused mid-turn within seconds; it resumes where it was if you come back soon, and
is gone if the Sprite was stopped in between. Ateam's engine doesn't take a task
hold yet, which is the fix: hold the Sprite while an agent works, and let it sleep
when none is. Two things keep that from shipping:

- **No scheduler.** A paused Sprite can't wake itself, so a loop has nothing to fire
  it on time. Something outside has to call the Sprite.
- **Restarts that lose recent writes.** Sprites on the `sbd` storage driver (check
  `echo $SPRITE_STORAGE_DRIVER`) can restart on their own a minute or two after
  waking, losing about the last minute of disk writes
  ([open thread](https://community.fly.io/t/sprite-restarts-by-itself-1-to-3-minutes-after-waking-from-idle-reproducible-sbd-storage/28796)).
  Ours did, twice in an hour. For Ateam that's the engine's database.

## Gotchas

- **An open `sprite console` keeps the Sprite awake** while its prompt produces
  output, and it's easy to forget one: `sprite create` opens a console and leaves it
  running. `sprite sessions list` shows them; `sprite sessions kill <id>` closes one.
- **`sprite info` status lags.** It said `cold` while processes were running. Don't
  read sleep state from it.
- **`sprite proxy --ssh` refuses keys.** The built-in SSH emulation answered
  `Permission denied (publickey)` for every key we tried, including the one sshd
  accepted. Use a real sshd and `-W :22` as above.
- **A key with a passphrase fails without saying why.** sshd logs `Accepted key`,
  then the login fails with `Permission denied (publickey,password)`, because the
  client can't sign without prompting. Use a key with no passphrase, or load it into
  `ssh-agent`.
- **`pkill -f` inside `sprite exec -- bash -c '…'`** matches the exec's own command
  line and kills it, silently skipping the rest of the command.
