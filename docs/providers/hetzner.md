# Hetzner

<img src="../../assets/providers/hetzner.svg" alt="Hetzner" width="48" />

[Hetzner Cloud](https://www.hetzner.com/cloud) VPS — an ordinary Ubuntu box you own,
on a public IPv4 you close off with Tailscale. It's the one provider Ateam can
**create for you**: the New Task dialog's **Run on** picker offers **Create a box**,
which provisions the server, generates the SSH key, joins your tailnet and installs
the engine, with no provider console or terminal to touch.

**Verified against** Ateam v0.1.87 · Hetzner Cloud · 2026-11-04. Run end to end in the
released app: Create a box with an API token and a tagged Tailscale auth key made an Arm
server (Ubuntu 24.04, 4 vCPU, 8 GB) with the engine running as its service, on the tailnet
with its tag, reached over the tailnet by a client speaking Ateam Go's protocol. The run
found the bugs that Ateam 0.1.88 fixes, listed under [Gotchas](#gotchas). **Not run:** the
0.1.88 form itself (a box without an auth key), and the by-hand path below.

## Create a box

**In the app:** New Task → **Run on** → **Create a box**, or Settings → Boxes → **Add a
box** → **Create a new box**. Name it and paste a Hetzner Cloud API token (your account,
your bill), then pick a region and a size from the account's live catalog.

- **The API token:** in the [Hetzner Console](https://console.hetzner.com/projects), open
  a project (or make one), then **Security** in the sidebar → **API tokens** → **Generate
  API token**, with **Read & Write**. Hetzner shows it once. The form links there.
- **The Tailscale auth key** is optional from Ateam 0.1.88. Leave it empty, and once the
  server is up your browser opens Tailscale's page to approve the box, as Set up phone
  access does ([recipe](README.md), step 4). Or make one in Tailscale's admin, **Settings
  → Keys → Generate auth key**: turn on **Tags** so the box never drops off your tailnet,
  and **Reusable** if Ateam should use it for your next boxes too (it keeps the key
  encrypted on this Mac; a one-off key works once).
- **Sizes:** a browser-capable x86 size with at least 4 GB is preferred to start with,
  falling back to available Arm or smaller sizes. You can choose a different size.
- **Browser:** included by default on x86 sizes, with an **Include browser** opt-out.
  Arm sizes do not support the browser. A browser setup failure leaves terminal work
  available; see `~/.ateam/browser-install.log` and retry from the Browser panel.

When the box is up, its page opens with what's left: GitHub, and signing in to an agent.

**From Ateam Go, with no Mac:** Get started → **Create a box here**, or **No box yet?** on
Add a box, then **Hetzner**. The same token, then how the phone connects: **SSH** (the default when the
phone isn't on Tailscale: the phone makes a key, and only that phone can log in, through
an `ateam-ssh-only` firewall that lets in only TCP 22) or **Tailscale**, with an auth key
the phone needs (nobody would see the link to approve the box with). Then a name, a place
and a size, with what Hetzner bills for them. With Tailscale, the box differs from one
the Mac makes:

- **It installs Ateam itself at first boot**, from its cloud-init: the same installer,
  with `--service --tailscale` and `--browser` when selected, run as the `ateam` user once Tailscale is up, after the
  coding agent picked on the page (Claude Code to start with, Codex, both, or none), so
  the engine finds it when it starts. Their output is `~/ateam-install.log` on the box.
- **Once it answers, Finish setting up**: sign in to the agent (its terminal opens with
  the agent's login command typed in), or, with none on the box, install one (its
  terminal installs it, then signs in), connect GitHub (which also gives commits your
  name), and add a project.
- **It knows the phone before Ateam first starts.** The phone makes a token of its own and
  puts only its sha256 in the cloud-init (`ATEAM_PAIR_DEVICE`, then `ateam pair
  --add-device`). The box starts private, with that phone paired.
- **No SSH key, and nothing in from the internet.** It sits behind a Hetzner firewall,
  `ateam-tailnet-only`, made the first time, which lets in only Tailscale's direct
  connections (UDP 41641); cloud-init turns password logins off. Hetzner emails a root
  password for a server made without a key: it works only in Hetzner's web console, which
  is where to look if the install fails.
- **Make the auth key one-off.** Any process on the box can read its cloud-init back from
  Hetzner's metadata service, the key included. A one-off key is spent by then; a reusable
  one could join other devices to your tailnet.

Run end to end on 2026-11-05 from this change, in the iOS simulator against a real Hetzner
account: Ateam answered on the box's tailnet port about two minutes after Create, the app
connected by the box's name and opened Add project, Tailscale connected directly (UDP 41641
through the firewall), and the box's public address answered neither SSH nor Ateam's port.
Not yet exercised: the phone pairing itself before the engine starts, which needs a release
with `ateam pair --add-device`, and a short name on a physical iPhone.

The phone then reaches the box by its name on your tailnet (MagicDNS). If the name
doesn't resolve on the phone, the page takes the address from the Tailscale app instead.
**Delete the server** there deletes it on Hetzner, with the IPv4 and IPv6 addresses
Hetzner made for it, which bill on their own.

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

Connect GitHub from Ateam, under GitHub on the box's page in **Settings → Boxes**, which opens after
Create a box, with a fine-grained token for the repositories the box works on (Ateam opens
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
binds the box's own tailnet IP, and the phone connects over the tailnet. Given an auth
key, Create a box joins with it. Make that key with a tag: a device it adds takes the tag,
and tagged devices don't expire, while an untagged one drops off the tailnet after 180 days
by default and the phone loses the box without saying why. The tag has to exist in your
tailnet's policy (`tagOwners`). Without a key, you approve the box from Tailscale's page,
and its key expires unless you turn that off; the box's page says when.

By hand, the installer's `--tailscale` joins the tailnet and opens the phone's port on
it (with `TS_AUTHKEY=<key>` it needs no browser), or set the address yourself:

```bash
export ATEAM_WS_ADDR=100.x.y.z:8787    # the box's OWN Tailscale IP
curl -fsSL https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh | bash -s -- --service
```

## Gotchas

- **Fixed in Ateam 0.1.88, seen on 0.1.87:** the size list offered types the chosen region
  doesn't sell, so Create failed with `unsupported location for server type`. Hetzner
  retires a type per location (the old shared AMD types left FSN, NBG, HEL and SIN on
  2026-01-01), and dropped the type-wide `deprecated` flag on 2026-11-02; the list now
  reads each location's own entry. The same run's dialog grew past the window with no way
  to scroll to Done, said "no coding agent yet" right after installing two, printed raw
  colour codes in its log, and preinstalled OpenCode where a login shell can't find it.

- **Allow the whole `tailscale0` interface, not just port 22.** `ufw enable` sets the
  default incoming policy to deny, so a port-22-only rule silently blocks the
  WebSocket port the iOS app needs.
- **Close the public port only after Tailscale works**, or you lock yourself out of
  your own server.
- **Agents run as a non-root user** with that user's git and `gh` credentials — don't
  give them root.
