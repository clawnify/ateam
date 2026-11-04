# Hetzner

<img src="../../assets/providers/hetzner.svg" alt="Hetzner" width="48" />

[Hetzner Cloud](https://www.hetzner.com/cloud) VPS — an ordinary Ubuntu box you own,
on a public IPv4 you close off with Tailscale. It's the one provider Ateam can
**create for you**: the New Task dialog's **Run on** picker offers **Create a box**,
which provisions the server, generates the SSH key, joins your tailnet and installs
the engine, with no provider console or terminal to touch.

**Verified against** — *not re-verified for this page.* The steps are carried from
[`../online-ateam.md`](../online-ateam.md), which is the canonical VPS walkthrough.
Re-stamp this line the next time you create a box end to end.

## Create a box

**In the app:** New Task → **Run on** → **Create a box**. Pick a region
(Falkenstein, Nuremberg, Helsinki, …) and a size, and paste a Hetzner Cloud API
token — your account, your bill. The picker reads the live per-account catalog, so
it only offers regions and sizes actually in stock.

**By hand:** create a **CX23** (x86) or **CAX11** (Arm64) — 2 vCPU / 4 GB / 40 GB —
on Ubuntu with your SSH key attached, then follow
[`../online-ateam.md`](../online-ateam.md) from step 0. Size for agents, not for the
app: roughly a gigabyte per concurrent agent session, plus your project's own dev
server and tests.

## What's preinstalled

Nothing. A fresh Ubuntu image has no `git`, no `gh`, no Node, and no agent CLIs —
you install all of them. The in-app flow does this for you; by hand it's step 0 of
the walkthrough.

## GitHub credentials

Connect GitHub from Ateam, in the checklist after Create a box or in **Settings → Boxes
→ GitHub**, with a fine-grained token for the repositories the box works on (Ateam opens
GitHub's form with the rest filled in; see [Sprites](sprites.md#github-credentials) for
the permissions). The git identity then sets itself from the account.

There is no provider-supplied credential helper to conflict with, so `gh auth login` on
the box works too, but it hands the box's agents a token that reaches every repo your
account can.

## Install the engine

```bash
curl -fsSL https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh | bash
```

Add `-s -- --service` to install a systemd unit — required for the iOS app, which
can't start a daemon on demand the way the desktop does over SSH. With passwordless
sudo (what this box's cloud-init grants) you get a *system* unit, which also survives
an out-of-memory kill; see [Keeping the daemon alive](../online-ateam.md#keeping-the-daemon-alive).

## Connect

Create a box writes a `Host` entry for the box to your Mac's `~/.ssh/config` (its public
address and the key Ateam generated) and connects it. For a box made by hand, add an
entry yourself, ideally pointing at the box's **tailnet** address (`100.x.y.z`) once
the public port is closed, and pick the alias in Ateam (New task → **Run on**, or
**Settings → Boxes → Add a box → Set up a box over SSH**), which installs the engine
and connects.

## iOS

**Yes, this is the reference setup.** The box joins your tailnet directly, the daemon
binds the box's own tailnet IP, and the phone connects over the tailnet. Create a box
joins with the Tailscale auth key you paste. Make that key with a tag: a device it adds
takes the tag, and tagged devices don't expire, while an untagged one drops off the
tailnet after 180 days by default and the phone loses the box without saying why. The
tag has to exist in your tailnet's policy (`tagOwners`).

By hand, the installer's `--tailscale` joins the tailnet and opens the phone's port on
it (with `TS_AUTHKEY=<key>` it needs no browser), or set the address yourself:

```bash
export ATEAM_WS_ADDR=100.x.y.z:8787    # the box's OWN Tailscale IP
curl -fsSL https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh | bash -s -- --service
```

## Gotchas

- **Allow the whole `tailscale0` interface, not just port 22.** `ufw enable` sets the
  default incoming policy to deny, so a port-22-only rule silently blocks the
  WebSocket port the iOS app needs.
- **Close the public port only after Tailscale works**, or you lock yourself out of
  your own server.
- **Agents run as a non-root user** with that user's git and `gh` credentials — don't
  give them root.
