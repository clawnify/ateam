# App Store Listing — Ateam Go

Copy for App Store Connect. Draft — tweak to taste before submitting.

## Identity
- **Name:** Ateam Go
- **Subtitle (≤30 chars):** `Run AI coding agents remotely` (29)
- **Bundle ID:** com.clawnify.ateam
- **Primary category:** Developer Tools
- **Secondary category:** Productivity
- **Age rating:** 4+ (no objectionable content — see questionnaire below)

## Promotional text (≤170 chars, updatable without review)
`Drive AI coding agents on your own server from your phone. Watch them work, jump into any session, and pick up where you left off — from anywhere.`

## Description
```
Ateam Go is a remote control for AI coding agents that run on your own server.

Your agents (like Claude Code) do the work on a machine you own; Ateam Go is the
polished phone client on top — a live board of every task, a real terminal for each
one, and the ability to pick up exactly where you left off.

LOCAL-FIRST, YOUR MACHINE
• Agents run on your box, not on our servers. There is no Ateam account and we collect
  nothing — the app talks only to a server you control, over your own private network.

A LIVE BOARD
• See every task across columns — Needs You, In Progress, Review, Backlog, Done.
• Start a new task and launch an agent from the composer.

A REAL TERMINAL IN YOUR POCKET
• Open any task to a full terminal attached to its running agent.
• Sessions live on your server, so they survive disconnects and app switches — reopen
  and you're right back in the running session.
• Attach a screenshot or photo straight into the agent.

TRY IT FIRST
• Tap "Try the demo" to explore the whole app offline, no server required.

Ateam Go pairs with the Ateam desktop app and an agent server you run yourself.
```

## Keywords (≤100 chars, comma-separated, no spaces after commas)
`ssh,terminal,claude,coding agent,ai,developer,remote,devops,server,tmux,console,shell,git`
_(96 chars — adjust if App Store Connect reports over.)_

## URLs
- **Support URL:** _needs a page_ — e.g. the repo or a Clawnify support page.
- **Marketing URL (optional):** a Clawnify/Ateam landing page if one exists.
- **Privacy Policy URL:** host `privacy-policy.md` (see that file's footer).

## Age-rating questionnaire → all "None" / "No"
Cartoon/fantasy violence, realistic violence, sexual content, nudity, profanity, alcohol/
tobacco/drugs, gambling, horror, mature themes, medical info, contests: **None**.
Unrestricted web access: **No** (the dev-server preview opens only a user-entered address on
their own network; not a general browser). → **Result: 4+**.

## App Privacy ("nutrition label") → Data Not Collected
Declare **"Data Not Collected."** Rationale:
- No analytics, no accounts, no ads, no tracking SDKs.
- Photos the user attaches and all terminal traffic go to **the user's own server**, not to
  Clawnify — this is not "collection" by the developer.
- Local settings (last box, project, port) stay on-device.
If App Store Connect pushes back on the photo point, the honest framing is: the app *accesses*
photos on device at the user's request and transmits the chosen one to the user's own server; the
developer neither collects nor receives it.

## Encryption / export compliance
Already declared in `app.json`: `ITSAppUsesNonExemptEncryption: false` (only OS-standard
TLS/SSH/WebSocket; no proprietary crypto). No extra paperwork.
