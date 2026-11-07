# Privacy Policy — Ateam & Ateam Go

**Effective date: November 6, 2026**

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
- the board each machine showed when the phone last reached it (its projects,
  tasks and loops), so a machine that is asleep when you open the app still
  lists them; it goes when you remove that machine from the list,
- your last-selected project, the machine whose Lead chat you use, and the
  machine new tasks start on when a project is on more than one,
- your preview-port preference, and
- your API key for each provider you have the app wake a machine through, which
  is kept in the iOS Keychain,
- for each machine you have locked to its paired devices, this phone's key to
  it, which that machine gave the phone when you paired them. It is kept in the
  iOS Keychain and is only ever sent to that machine, and
- reminders for tasks you parked until a date: the task's name, what it waits on and when it comes
  due, handed to iOS as local notifications that the phone itself delivers. No
  push service is involved, and the app asks for notification permission the
  first time there is one to schedule.

This exists solely so the app reopens where you left off, shows every machine's
projects even while one is asleep, and never asks you to retype a machine. Apart
from the provider key and machine name, which go to that provider as described
below, it never leaves the device, and deleting the app deletes it.

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

To pair the phone with a machine you have locked to its paired devices, you can
scan the pairing code the Ateam desktop app shows. Ateam Go uses the camera only
while that scanner is open, reads the code on the phone, and keeps no image:
nothing the camera sees is stored or sent anywhere. The code it reads goes only
to your own machine, which answers with the phone's key to it. The app asks for
camera permission the first time you open the scanner, and you can type the code
instead.

If you connect GitHub on one of your machines from either app, the token you
paste is sent once to that machine, over the same connection, and Ateam Go
keeps no copy. The machine stores it for its own git and checks with GitHub
which of your repositories it reaches, under your own GitHub account. The button
that helps you make a token opens GitHub's own page in your browser.

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

### Creating a machine on Hetzner (optional)

If you create a machine from Ateam Go (Create a box), the app sends the Hetzner
API token you enter, and the machine's name, place and size, to Hetzner's API
(`api.hetzner.cloud`), under your own Hetzner account, which Hetzner bills, and
Hetzner's terms and privacy policy. The token is kept in the iOS Keychain. The
machine's setup script, which Hetzner keeps with the machine, carries the
Tailscale auth key you enter (so the machine can join your network) and a
one-way hash of a token this phone keeps (so the machine recognises the phone);
the token itself never leaves the phone. Nothing goes to us.

### AI features with your own keys (optional)

With an OpenRouter or OpenAI API key of yours, Ateam can sort finished tasks
into Needs you, write task titles and summaries, filter grammar suggestions
(desktop app) and take calls with the Lead. You add a key in the desktop app
(Settings → AI) or, for one of your machines, in Ateam Go. The key is stored on
that machine, not on the phone, and the text these features need (an agent's
last message and your reply, a task's prompts) goes to the key's provider under
your own account. Without a key, nothing goes to them.

### Calls with the Lead (optional)

During a call, what you say goes to OpenAI's realtime voice service, on the
OpenAI key of your Mac or of the machine whose Lead it is, and its voice speaks
the Lead's replies. Your words land in the Lead chat as text. The apps keep no
audio, and the microphone is used only during a call you start.

## AI coding agents

The apps orchestrate AI coding agents — such as Claude Code, OpenCode, and
Codex — that **you install and run on your own computer, under accounts you
hold directly with those providers** (for example Anthropic or OpenAI). The
Ateam apps themselves include no AI SDK, and reach an AI provider only through
the optional features above.

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
settings, plugins and connectors, exactly as it runs in your terminal. Files
you attach in the Lead chat are copied into the app's own folder on your Mac
and deleted after 30 days. The Lead reads them like any file you show Claude
Code, and when you hand one to a task on one of your boxes, a copy goes to
that box over your own connection.

The Lead can also run on one of your machines instead of your Mac, and that is
the Lead chat Ateam Go shows: the phone sends your messages and attachments to
that machine over your own connection, and the Claude Code installed there, under
your own account, answers them. Ateam Go itself sends nothing to Anthropic.

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
