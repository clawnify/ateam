# exe.dev

[exe.dev](https://exe.dev) rents persistent Linux VMs you reach over SSH: a real
kernel, `systemd`, a disk on local NVMe that's streamed to another server in the
region as it changes. You pay a flat monthly price for a pool of CPU and memory
(Personal: 2 vCPU / 4 GB with 100 GB of disk for $15/mo, up to 16 vCPU / 32 GB)
that up to 50 VMs share. Nothing pauses a VM for being idle, so there's no sleep
to manage and no sleep code in Ateam: an agent left working alone keeps working.

**Verified against** Ateam v0.1.70 · exe.dev on a 7-day trial account, region `fra` ·
2026-10-30. Run end to end: creating the box, the install, the desktop's handshake
and `-L` forwards, a box left alone, and [iOS](#ios): the VM joined a tailnet with
`tailscale up` and Ateam Go connected over it. **Not run:** exe.dev's Tailscale
integration, which is written from its docs.

## Create a box

exe.dev's CLI is SSH. Your SSH key is your account: the first `ssh exe.dev` walks
you through signing up and choosing a plan.

```bash
ssh exe.dev                  # sign up, pick a plan
ssh exe.dev new --name=mybox
```

Pick at least the 4 vCPU / 8 GB capacity ($35/mo) for more than one or two agents
at a time: every VM shares the pool, and so does every agent on it. Change it with
`ssh exe.dev billing capacity --cpu=4`.

exe.dev writes **nothing** to `~/.ssh/config`. `ssh mybox.exe.xyz` works anyway, but
Ateam only offers aliases it finds there, and it skips any `Host` line holding a
pattern. So name the box on its own line:

```sshconfig
Host mybox.exe.xyz

Host exe.dev *.exe.xyz
  IdentitiesOnly yes
  IdentityFile ~/.ssh/id_ed25519_exe
```

The second block is only needed if your exe.dev key isn't your default one. Don't
write `Host exe.dev` on a line of its own: Ateam would offer it as a box, and it's
exe.dev's control plane, not a VM.

If `ssh mybox.exe.xyz` ever fails to route, the destination that always works is
`vm+mybox@vm.exe.xyz`:

```sshconfig
Host mybox.exe.xyz
  HostName vm.exe.xyz
  User vm+mybox
```

## What's preinstalled

The default `exeuntu` image (Ubuntu 24.04, kernel 6.12): `git`, `gh`, `go`,
`docker`, `tailscale`, `systemd` as init, and all three agent CLIs, `claude`,
`codex` and `opencode`. You log in as `exedev` with passwordless `sudo`. A new VM
on the trial had 2 vCPUs, 7 GB of memory and a 25 GB disk.

**Not** present: `node` (the installer adds it) and `bun`. `sshd` is installed but
not running, and nothing listens on port 22: exe.dev ends SSH at its own proxy, as
[boxd](boxd.md) does, so leave it off.

`claude` and `codex` are fixed at the versions the image was built with; update
them with `sudo exeuntu update claude` and `sudo exeuntu update codex`.

## GitHub credentials

Give the box a [fine-grained token](sprites.md#github-credentials) limited to the
repos it works on:

```bash
pbpaste | ssh mybox.exe.xyz 'gh auth login --with-token'
ssh mybox.exe.xyz 'gh auth setup-git'
```

exe.dev's own [GitHub integration](https://exe.dev/docs/integrations-github.md)
keeps the token off the VM, but it doesn't fit Ateam: it serves each repo from its
own host, `https://github.int.exe.xyz/<owner>/<repo>.git`, and `gh` only through
`GH_HOST=github.int.exe.xyz`. Ateam clones from `github.com` and runs `gh` without
that variable, so it would see neither.

## Install the engine

```bash
ssh mybox.exe.xyz 'git config --global user.name "you" && git config --global user.email "you@example.com"'
ssh -t mybox.exe.xyz claude          # preinstalled; log in once, then exit

ssh mybox.exe.xyz 'curl -fsSL https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh | bash -s -- --service'
```

`systemd` is the init here, so `--service` gives the engine a systemd unit and it
comes back after a reboot.

## Connect

Pick **`mybox.exe.xyz`** in the connection switcher.

## iOS

The image ships `tailscale`, and `/dev/net/tun` is there, so it runs in its normal
kernel mode. Its daemon is installed but off; turn it on first, or `tailscale up`
fails with `failed to connect to local tailscaled`:

```bash
ssh mybox.exe.xyz 'sudo systemctl enable --now tailscaled'
```

Then join your tailnet. The plain way prints a login URL to approve, once:

```bash
ssh -t mybox.exe.xyz 'sudo tailscale up --hostname=mybox'
```

Or let exe.dev's [Tailscale
integration](https://exe.dev/docs/integrations-tailscale-wif.md) join it, which puts
no auth key on the VM. Follow that page, with one change: join with
`ephemeral=false`, not the `ephemeral=true` it shows. An ephemeral node is removed
from the tailnet after it has been offline a while, and comes back with a new
address, which strands the phone's port the engine was given.

Then give the engine its phone port on the VM's tailnet IP (`tailscale ip -4`):

```bash
curl -fsSL https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh | ATEAM_WS_ADDR=<tailnet-ip>:8787 bash -s -- --service
```

The installer's readiness report then shows `[ok] tailscale up (<tailnet-ip>)` and
`phone listener up on <tailnet-ip>:8787`. In Ateam Go, connect to
`ws://<tailnet-ip>:8787`. A VM never sleeps, so the phone needs no provider or wake
settings.

## Left alone

What we measured on one VM, with the engine installed as above:

| | |
| --- | --- |
| The desktop's handshake (`ateam attach --stdio` over `ssh mybox.exe.xyz`) | Answered at once |
| A `-L` forward to a loopback port on the VM, as the desktop opens them | Serving about 1s after ssh started |
| A heartbeat writing every 30s, nothing connected | Never missed a beat in 8 minutes, the longest gap 30s |
| The engine's systemd unit, nothing connected | Still `active` after those 8 minutes |

exe.dev documents no idle stop for a VM in a pool, and 8 minutes is longer than
Sprites (seconds) or Daytona's default pause would allow, but it isn't an hour. A
longer run should replace that row.

## Gotchas

- **Every VM shares the pool.** A box is not sized on its own: two busy VMs on the
  2 vCPU plan each get about one core. Size the pool for everything running on it.
- **Disk is an allowance for the account, not a per-VM size.** It's measured as
  filesystem usage, and usage beyond the allowance is billed per GiB-month.
