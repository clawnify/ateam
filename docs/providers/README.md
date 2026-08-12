# Box providers

A **box provider** is any service that hands you a Linux box you can SSH into.
Ateam offers every `Host` alias it finds in your `~/.ssh/config`, so a provider
needs **no Ateam-side integration at all** — if their CLI writes an alias (or you
add one yourself), the box shows up in the connection switcher.

That makes the recipe the same everywhere:

1. Create a box with the provider's own tooling.
2. Run [`install.sh`](../../packages/server/scripts/install.sh) on it over that alias.
3. Give it a git identity, sign into `gh`, and log into an agent CLI once.
4. Pick the alias in Ateam's connection switcher.

What differs between providers is the boring, unguessable detail — what's
preinstalled, how git credentials work, whether there's an `sshd` in the box at
all. That's what the pages here record.

## Providers

| Provider | Kind | Desktop | iOS |
| --- | --- | --- | --- |
| [boxd](boxd.md) | persistent KVM microVMs | ✅ via boxd's SSH proxy | ⚠️ works, but needs manual Tailscale setup |
| Your own VPS | Hetzner, EC2, a home server… | ✅ | ✅ | 

For a VPS from scratch, see [`../online-ateam.md`](../online-ateam.md) — that's the
reference walkthrough these pages assume you've skimmed.

> **Not the same as "Create a box" in the app.** The desktop can *provision* a VPS
> for you (currently Hetzner) via the `BoxProvider` interface in
> `packages/server/src/provision.ts`. That's a code integration holding your API
> token, and it's maintained in-tree rather than contributed — each one is a live
> API client whose breakage looks like an Ateam bug. This directory is for the
> other kind: services you drive with their own CLI, which need no code from us.

## Adding a provider

Open a PR with `docs/providers/<name>.md` using the template below, and add a row
to the table above. Docs only — no code changes are needed or wanted.

**Every page must carry a `Verified against` line.** These pages rot fast: ours
was wrong within eight days of being written, and confidently-wrong setup
instructions are worse than none, because people follow them. If you can't say
when you last ran the steps, don't publish the page.

### Template

```markdown
# <Provider>

<One paragraph: what kind of box, what it costs, what's unusual about it.>

**Verified against** Ateam vX.Y.Z · <provider CLI version> · YYYY-MM-DD

## Create a box

<The provider's CLI commands, from install to a running box.>

<What lands in ~/.ssh/config, and exactly which alias to pick.>

## What's preinstalled

<git, gh, node, docker, agent CLIs — and what's missing that you'd expect.>

## GitHub credentials

<Does the provider supply git credentials, or do you run `gh auth login`?
Anything that would clash with the provider's own mechanism?>

## Install the engine

<The install.sh one-liner, plus any provider-specific flags or env.>

## Connect

<Which alias to pick in the switcher; anything surprising in the list.>

## iOS

<Can the phone reach it? The phone needs a WebSocket over Tailscale, so: can the
box join a tailnet, and can an arbitrary TCP port be reached on it?>

## Gotchas

<The things that cost you an hour. Be specific — quote the error text.>
```

### What each section is really asking

These aren't arbitrary headings; each one is a thing that silently differed on a
real provider and cost real time:

- **Which alias** — one provider writes *three* `~/.ssh/config` entries per
  machine, one of which isn't a machine at all.
- **What's preinstalled** — a microVM image may already have `git`, `gh`, `node`,
  `docker` and `claude`; a bare VPS has none of them.
- **GitHub credentials** — a provider may supply a git credential helper of its
  own, in which case the usual `gh auth setup-git` *replaces* it and quietly
  breaks the better mechanism.
- **Is there an `sshd` in the box?** Not always. A provider can terminate SSH at
  its own proxy, so anything assuming a local SSH service fails in a confusing
  way.
- **iOS** — the phone has no SSH; it needs a WebSocket over Tailscale. Whether
  that's possible is the single biggest capability difference between providers,
  and it depends on details as obscure as whether the kernel ships `/dev/net/tun`.
