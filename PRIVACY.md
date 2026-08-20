# Privacy Policy — Ateam & Ateam Go

**Effective date: August 20, 2026**

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

- the host and port of the last machine you connected to,
- your last-selected project, and
- your preview-port preference.

This exists solely so the app reopens where you left off. It never leaves the
device, and deleting the app deletes it.

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

GitHub operations (push, pull, PRs) are performed by the `gh` CLI on your own
machine, under your own GitHub authentication.

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
