# Privacy Policy — Ateam & Ateam Go

**Effective date: October 31, 2026**

Ateam (the desktop app) and Ateam Go (the iOS companion app) are local-first
tools published by Clawnify. This policy describes what data the apps handle,
where it goes, and who can see it. The short version: **we operate no backend,
run no analytics, and never receive your data.** Everything the apps do happens
between your own devices.

## What we collect

**Nothing.** Neither app has user accounts, sign-in, analytics, telemetry,
crash reporting, advertising identifiers, or any tracking of any kind. No data
about you or your usage is transmitted to Clawnify or to any service operated
on our behalf.

## What stays on your device

Ateam Go stores a small amount of data locally on your phone, and only there:

- the machines you have connected to, each with its host and port and, if you
  have the app wake it through its provider (below), the provider you picked
  and the machine's name there. Each one stays in the app's list until you
  remove it,
- your last-selected project,
- your preview-port preference, and
- your API key for each provider you have the app wake a machine through, which
  is kept in the iOS Keychain, and
- reminders for tasks you parked until a date: the task's name, what it waits on and when it comes
  due, handed to iOS as local notifications that the phone itself delivers. No
  push service is involved, and the app asks for notification permission the
  first time there is one to schedule.

This exists solely so the app reopens where you left off and you can switch
machines without retyping them. Apart from the provider key and machine name,
which go to that provider as described below, it never leaves the device, and
deleting the app deletes it.

The Ateam desktop app stores your projects, tasks, and settings in a local
database on your computer. That data likewise never leaves your machine through
anything we operate.

## Where your data goes when you use the app

Ateam Go is a remote control for **your own computer**. It connects over
**your private network** (typically a [Tailscale](https://tailscale.com)
tailnet you configured) directly to the Ateam server running on a machine you
own. Everything you see and type in the app — terminal output, task boards,
diffs, prompts — travels only between your phone and that machine. There is no
intermediary server, and Clawnify is not part of the connection.

If you attach a photo from your library, it is sent to your own machine over
that same private connection so the agent running there can use it. Photo
library access is invoked only when you explicitly attach an image.

### Waking a machine through its provider (optional)

If your machine is hosted with a provider that can put it to sleep, you can pick
that provider on the connection screen and enter your API key for it. Ateam Go
then contacts that provider's API before connecting, to wake the machine if it
is asleep, and once when you save the key, to check that it works. It sends only
your API key and the machine's name (for Sprites, also a fixed command that keeps
the machine awake for five minutes while the app connects), under your own account
and that provider's terms and privacy policy. The providers it can contact, and
the addresses it uses:

- [boxd](https://boxd.sh): `app.boxd.sh` and `boxd.sh`
- [Sprites](https://sprites.dev) (Fly.io): `api.sprites.dev`

With no provider picked, Ateam Go contacts none of them.

## AI coding agents

The apps orchestrate AI coding agents — such as Claude Code, OpenCode, and
Codex — that **you install and run on your own computer, under accounts you
hold directly with those providers** (for example Anthropic or OpenAI). The
Ateam apps themselves include no AI SDK and send nothing to any AI provider.

When you instruct an agent to work, the agent software on your machine
communicates with its provider under your own credentials and that provider's
terms and privacy policy. Which providers are involved, and what code or
prompts they receive, is entirely determined by which agents you chose to
install and what you ask them to do. We recommend reviewing the privacy terms
of the AI providers you use:

- Anthropic (Claude Code): https://www.anthropic.com/legal/privacy
- OpenAI (Codex): https://openai.com/policies/privacy-policy

The desktop app's Lead chat is one more of these agents: it runs the Claude
Code you installed, under your own account and with your own Claude Code
settings, plugins and connectors, exactly as it runs in your terminal.

GitHub operations (push, pull, PRs) are performed by the `gh` CLI on your own
machine, under your own GitHub authentication.

## Pages that agents make

An agent can show you an HTML page it made, such as a dashboard or a
comparison. The desktop app draws it in a sandboxed frame that cannot read
anything else in Ateam. The page can, however, load scripts, styles, fonts and
images from public web addresses (for example a library from a CDN such as
jsDelivr), so opening it makes your computer request those files from the
sites the page names, as a web browser would. Which sites those are is decided
by the agent that wrote the page.

## Demo mode

Ateam Go includes a fully offline demo mode backed by canned data. It opens no
network connection at all.

## Children

The apps are developer tools and are not directed at children.

## Changes

If this policy changes, the updated version will be published at this URL with
a new effective date. Since the apps transmit nothing to us, changes can only
ever narrow or clarify — there is no collected data to repurpose.

## Contact

Questions: open an issue at https://github.com/clawnify/ateam/issues or
contact Clawnify via https://github.com/clawnify.
