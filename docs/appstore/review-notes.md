# App Review Notes — Ateam Go

_Paste into App Store Connect → App Review Information → Notes._

---

Ateam Go is a **local-first** remote control for AI coding agents (e.g. Claude Code) that a
developer runs on **their own server**. It is the companion to our macOS desktop app.

**There is no account and no Clawnify-operated backend.** In normal use the app connects over the
user's own private [Tailscale](https://tailscale.com) network to a server the user operates. Because
that server is private to each user, we **cannot** provide demo credentials that reach "our"
backend — there is no shared backend.

**Per Guideline 2.1, we provide a fully-featured built-in demo instead of a demo account.**

## How to review the app

1. Launch the app. On the first screen, tap **"Try the demo — no box needed"** (below the connection
   form).
2. You'll land on the **board**, populated with sample tasks across the columns (Needs You / In
   Progress / Review / Backlog / Done).
3. **Tap any task** to open its terminal — you'll see a representative AI coding-agent session.
4. The **composer** at the bottom creates a sample task; the **paperclip** in a task's terminal
   attaches a photo; the **↗** button in the board header is a dev-server preview.

Demo mode runs **entirely offline** with fabricated data — no login, no network, no external
resources required.

## Notes on permissions

- **Photo library**: requested only if the reviewer taps the attach (paperclip) button. Used solely
  to let the user pick an image to send to their own server. No photos are sent to Clawnify.

## Real-world use (context, not required to review)

Outside demo mode, a user installs our open server on their own machine and connects over Tailscale.
There is nothing for Apple to provision. Everything a reviewer needs is in the demo.

Contact for anything: **pallaororm@gmail.com**
