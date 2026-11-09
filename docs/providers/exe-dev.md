# exe.dev

[exe.dev](https://exe.dev) rents persistent Linux VMs you reach over SSH: a real
kernel, `systemd`, a disk on local NVMe that's streamed to another server in the
region as it changes. You pay a flat monthly price for a pool of CPU and memory
(Personal: 2 vCPU / 4 GB with 100 GB of disk for $15/mo, up to 16 vCPU / 32 GB)
that up to 50 VMs share. Nothing pauses a VM for being idle, so there's no sleep
to manage and no sleep code in Ateam: an agent left working alone keeps working.

**Verified against** Ateam v0.1.87 · exe.dev on a trial account, region `fra` ·
2026-11-04. Run end to end on a new VM: adding a key to an existing account, the two
`~/.ssh/config` entries below, setting the VM up from Settings → Boxes with nothing
typed on it, and [iOS](#ios). **Not run:** Ateam Go itself, and exe.dev's Tailscale
integration, which is written from its docs. Measured 2026-10-30 on v0.1.70 and not
re-run: the VM [left alone](#left-alone).

## Create a box

exe.dev's CLI is SSH. Your SSH key is your account: the first `ssh exe.dev` walks
you through signing up and choosing a plan.

```bash
ssh exe.dev                  # sign up, pick a plan
ssh exe.dev new --name=mybox
```

Ateam connects with `BatchMode=yes`, so it can't prompt for a passphrase. If your
default key has one, give exe.dev a key of its own: `ssh` offers your default keys in
turn, so a plain `ssh exe.dev` can stop at a passphrase prompt for `~/.ssh/id_rsa`.
Sign up with the new key, or, if you have an account already, run the same command and
enter the account's email: exe.dev then adds the key to that account ("Your new ssh key
has been added to your existing account", 2026-11-04).

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519_exe
ssh -i ~/.ssh/id_ed25519_exe -o IdentitiesOnly=yes exe.dev     # sign up, or add it
```

`IdentitiesOnly` matters here: without it, `ssh` offers any keys in your agent before
the one named with `-i`, and exe.dev can end up signing up one of those instead.

Pick at least the 4 vCPU / 8 GB capacity ($35/mo) for more than one or two agents
at a time: every VM shares the pool, and so does every agent on it. Change it with
`ssh exe.dev billing capacity --cpu=4`.

exe.dev writes **nothing** to `~/.ssh/config`. `ssh mybox.exe.xyz` works anyway, but
Ateam only offers aliases it finds there, and it skips any `Host` line holding a
pattern. So name the box on its own line, and point every `ssh` to exe.dev at its key:

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

The default `exeuntu` image (Ubuntu 24.04): `git`, `gh`, `go`, `python3`, `docker`,
`tailscale` (installed, its daemon off), `systemd` as init, and three agent CLIs,
`claude`, `codex` and `opencode`. You log in as `exedev` with passwordless `sudo`. A
new VM on the trial had 2 vCPUs, 7 GB of memory and a 25 GB disk.

**Not** present: `node` (the installer adds it) and `bun`. `sshd` is installed but
not running, and nothing listens on port 22: exe.dev ends SSH at its own proxy, as
[boxd](boxd.md) does, so leave it off.

`claude` and `codex` are fixed at the versions the image was built with; update
them with `sudo exeuntu update claude` and `sudo exeuntu update codex`.

## GitHub credentials

Connect GitHub from Ateam, under GitHub on the box's page in **Settings → Boxes**, which opens after
Set up, with a [fine-grained token](sprites.md#github-credentials) limited to the
repos the box works on: Ateam opens GitHub's form with the rest filled in and hands the
token to `gh` on the VM. The git identity then sets itself from the account.

exe.dev's own [GitHub integration](https://exe.dev/docs/integrations-github.md)
keeps the token off the VM, but it doesn't fit Ateam: it serves each repo from its
own host, `https://github.int.exe.xyz/<owner>/<repo>.git`, and `gh` only through
`GH_HOST=github.int.exe.xyz`. Ateam clones from `github.com` and runs `gh` without
that variable, so it would see neither.

## Install the engine

Pick **`mybox.exe.xyz`** in Ateam: New task → **Run on** lists it as not set up yet, or
use **Settings → Boxes → Add a box → Set up a box over SSH**. Ateam accepts the VM's host
key on first contact, installs the engine over SSH as a systemd unit, and connects. On a
new VM that took about 70 seconds (2026-11-04), with nothing to type on it. Then log
into an agent once:

```bash
ssh -t mybox.exe.xyz claude          # preinstalled; log in, then exit
```

By hand instead, the same install Ateam runs:

```bash
ssh mybox.exe.xyz 'curl -fsSL https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh | bash -s -- --service'
```

`systemd` is the init here, so `--service` gives the engine a systemd unit and it
comes back after a reboot.

## Connect

Pick **`mybox.exe.xyz`**. A box set up from Ateam is connected already, and stays
listed in Settings → Boxes.

## iOS

The image ships `tailscale` with its daemon off, and `/dev/net/tun` is there, so it runs
in its normal kernel mode. **Set up phone access**, under Access on the box's page in
Settings → Boxes (Ateam 0.1.88 or later), does the rest: Ateam runs the installer again
with `--tailscale`, which starts `tailscaled`, joins the VM to your tailnet and opens the
engine's network port on its tailnet address. Your browser opens Tailscale's page to
approve the VM: press **Connect** at the end of it, or nothing happens. Then add the VM in
Ateam Go at the address the page shows, on an iPhone signed in to the same Tailscale
account. The [recipe](README.md) has the rest: no Tailscale account yet, and key expiry.
From a terminal, the same thing:

```bash
ssh mybox.exe.xyz 'curl -fsSL https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh | bash -s -- --tailscale'
```

It waits up to 15 minutes for the approval. An approval that comes later still puts the VM
on your tailnet, but leaves the engine without its port: run the setup again, and it
finishes without a new link (about a minute, 2026-11-04). The installer ends with the
address for Ateam Go (`Ateam Go reaches it at 100.x.y.z:8787`), and the VM's page shows it
too. With `TS_AUTHKEY=<key>` before `bash` it joins without a link; a key made with a tag
keeps the VM on the tailnet for good, while a device approved from a link drops off after
180 days unless you turn key expiry off for it.

Or let exe.dev's [Tailscale
integration](https://exe.dev/docs/integrations-tailscale-wif.md) join it, which puts
no auth key on the VM. Follow that page, with one change: join with
`ephemeral=false`, not the `ephemeral=true` it shows. An ephemeral node is removed
from the tailnet after it has been offline a while, and comes back with a new
address, which strands the phone's port the engine was given. Then run the installer
with `--tailscale` as above: it finds the VM on the tailnet and only opens the port.

A VM never sleeps, so the phone needs no provider or wake settings. From the release
after Ateam 0.1.90, the VM's engine says it runs on exe.dev (it reads
`init=/exe.dev/bin/exe-init` on the kernel command line). Ateam Go then names the box's
card exe.dev (from the version after 1.4.1), and Settings → Boxes names its row while
it's connected. exe.dev publishes no square vector mark, so the card keeps the plain
server tile. A VM set up with Ateam from v0.1.93 starts private to your paired devices;
an older one stays open to your tailnet until you make it private under Access on the
VM's page.

## Left alone

What we measured on one VM, with the engine installed as above:

| | |
| --- | --- |
| The desktop's handshake (`ateam attach --stdio` over `ssh mybox.exe.xyz`) | Answered at once |
| A `-L` forward to a loopback port on the VM, as the desktop opens them | Serving about 1s after ssh started |
| A heartbeat writing every 30s, left alone but for a few short SSH checks and one phone connection | Never missed a beat in 80 minutes (160 beats, the longest gap 31s) |
| The engine's systemd unit over the same 80 minutes | Still `active`, the VM up the whole time |

exe.dev documents no idle stop for a VM in a pool. A Sprite pauses within seconds of
being left alone and Daytona after 60 minutes by default; this VM ran through 80.

## Gotchas

- **Every VM shares the pool.** A box is not sized on its own: two busy VMs on the
  2 vCPU plan each get about one core. Size the pool for everything running on it.
- **Disk is an allowance for the account, not a per-VM size.** It's measured as
  filesystem usage, and usage beyond the allowance is billed per GiB-month.
