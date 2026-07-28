# Publishing Ateam Go to the App Store

Working folder for the public App Store submission. Internal TestFlight already works with no
review; this is the checklist + copy for a **public listing** (which triggers App Review).

See also [publishing-ios.md](../publishing-ios.md) for the build/upload mechanics.

## Status

| Item | State |
| --- | --- |
| Build on TestFlight | ✅ build 6 (`com.clawnify.ateam`, 1.0.0) |
| **2.1 backend blocker** — reviewer can reach the app | ✅ **built-in demo mode** ("Try the demo — no box needed") |
| Review notes | ✅ draft — [review-notes.md](./review-notes.md) |
| Privacy policy (text) | ✅ draft — [privacy-policy.md](./privacy-policy.md) · ⬜ **needs hosting at a public URL** |
| Listing copy (name/subtitle/description/keywords) | ✅ draft — [listing.md](./listing.md) |
| App Privacy label | ✅ "Data Not Collected" — see [listing.md](./listing.md) |
| Age rating | ✅ 4+ — see [listing.md](./listing.md) |
| Encryption / export compliance | ✅ `ITSAppUsesNonExemptEncryption: false` |
| **Screenshots** | ⬜ **to capture** — spec + pipeline below |

**Remaining to submit:** (1) host the privacy policy → get a URL; (2) capture screenshots;
(3) paste the copy into App Store Connect and submit.

## Screenshots

Apple requires, for an app that supports iPad:
- **iPhone 6.9"** — `iPhone 16 Pro Max`, **1290 × 2796** (installed ✓)
- **iPad 13"** — `iPad Pro 13-inch (M4)`, **2064 × 2752** (installed ✓)

`xcrun simctl io booted screenshot` captures at exact native (= App Store) resolution. Capture all
shots **in demo mode** — the canned data is deterministic, so shots are clean and reproducible.

### Screens to capture (5 per device)
1. **Board** — populated with the demo tasks (the hero shot).
2. **Task terminal** — a task opened to its Claude Code session.
3. **Composer** — the board with the composer focused / a prompt typed.
4. **Dev-server preview** — the ↗ preview modal (or the paperclip image-attach).
5. **Connection screen** — showing "Try the demo" (tells the local-first story).

### Capture commands (once the app is on the right screen)
```bash
# boot the device
xcrun simctl boot "iPhone 16 Pro Max"
open -a Simulator
# … get the app to the target screen …
xcrun simctl io booted screenshot ~/Desktop/ateam-shots/iphone-1-board.png
# repeat per screen; then for iPad:
xcrun simctl boot "iPad Pro 13-inch (M4)"
xcrun simctl io booted screenshot ~/Desktop/ateam-shots/ipad-1-board.png
```

### The navigation gap (and the fix)
`simctl` can capture but **cannot tap** — and `idb`/`fastlane` are not installed. So getting the app
onto screens 2–4 needs either:
- **Manual:** a person taps to each screen; the script captures. ~5 min for both devices.
- **Automated (recommended, repeatable):** add a `ateamgo://` **deep-link** handler so
  `xcrun simctl openurl booted ateamgo://demo/terminal` jumps straight to a screen. Then a script
  fully automates both device sets — reusable every release. Costs a URL scheme in `app.json`, a
  small `Linking` handler in `App.tsx`, and one simulator build.

## Order of operations to go live
1. Host `privacy-policy.md` → Privacy Policy URL.
2. Capture the 10 screenshots (5 × 2 devices).
3. App Store Connect: fill listing (from `listing.md`), App Privacy, age rating, review notes,
   upload screenshots, attach build 6, **submit for review**.
