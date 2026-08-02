# Ateam Go — Privacy Policy

_Last updated: 2026-07-28_

Ateam Go is a **local-first** remote control for AI coding agents that you run on **your own
server** ("your box"). This policy explains what the app does and does not do with your data.

## The short version

**Clawnify does not collect, store, or receive any of your data.** Ateam Go has no accounts,
no analytics, and no Clawnify-operated backend. The app talks **only to a server you own and
control**, over your own private network.

## What the app connects to

- When you connect, Ateam Go opens a WebSocket **directly to a box you operate**, reachable over
  your own [Tailscale](https://tailscale.com) private network. Your commands, keystrokes, terminal
  output, and any images you attach travel **between your phone and your box** — they are never
  sent to Clawnify or any third party.
- Clawnify runs **no server** that participates in this connection and receives **none** of this
  traffic.

## Data the app accesses on your device

- **Photos (optional).** If you tap the attach (paperclip) button, iOS asks permission to access
  your photo library so you can pick an image to hand to the agent. The selected image is uploaded
  **to your own box** (for your agent to read) and is **not** transmitted to Clawnify. The app does
  not read your photo library for any other purpose.
- **Local settings.** The last box address, selected project, and preview port are stored **on your
  device** (local storage) so the app remembers them between launches. This never leaves your device.

## Demo mode

The built-in **"Try the demo"** runs **entirely offline** with fabricated sample data. It makes no
network connections and accesses nothing on your device.

## Analytics & tracking

None. Ateam Go contains **no** analytics SDKs, advertising SDKs, or tracking of any kind. We do not
use the Advertising Identifier and we do not track you across apps or websites.

## Children

Ateam Go is a developer tool and is not directed at children.

## Changes

If this policy changes, the "Last updated" date above will change and the revised policy will be
posted at this URL.

## Contact

Questions: **_[set a support/privacy contact address before publishing — e.g. privacy@clawnify.com]_**

---

> **To publish:** this file must be hosted at a public HTTPS URL (App Store Connect requires a
> Privacy Policy URL). Options: a page under a Clawnify domain, or GitHub Pages for the repo.
> The URL then goes in App Store Connect → App Privacy → Privacy Policy.
