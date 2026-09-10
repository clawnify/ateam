---
name: run-desktop
description: Launch the Ateam desktop (Electron) app and drive its UI — hover, click, screenshot, query the DOM — against a throwaway data dir seeded with demo tasks. Use when a change needs to be seen working in the real app, when asked to run/start/screenshot Ateam, or to verify hover/scroll/list states that only appear with a full board.
---

# Run and drive the Ateam desktop app

Verifies a renderer change in the running app without touching the developer's
real data or the dev instance another worktree may already have open.

## Inputs

- `data-dir` — throwaway user-data dir (use the session scratchpad, not `/tmp`)
- `cdp-port` — DevTools port, default `9333`
- `count` — how many demo tasks to seed, default `45`

## Procedure

1. **Launch** (background — the process stays up; never pipe it through `tail`,
   which buffers stdout and hides startup errors):

   ```bash
   bash .claude/skills/run-desktop/launch.sh "$SCRATCH/udata" 9333
   ```

   It installs, rebuilds native modules if their arch is wrong, builds, and
   launches with `--user-data-dir` + `--remote-debugging-port`.

2. **Wait for the window** — the browser answers on the port before any
   BrowserWindow exists, so poll for a *page* target, not just the port:

   ```bash
   until curl -s http://127.0.0.1:9333/json/list | grep -q '"type": "page"'; do sleep 2; done
   ```

   No page target after ~30s means main crashed — read the launch output file.

3. **Seed, if the UI needs a populated board** (empty state otherwise):

   ```bash
   bash .claude/skills/run-desktop/seed-tasks.sh "$SCRATCH/udata/ateam.sqlite" 45
   ```

   The app must have run once to create the schema. Seed, then `reload` in the
   next step — the renderer refetches projects and tasks on load.

4. **Drive it and look at what comes back:**

   ```bash
   bun .claude/skills/run-desktop/drive.ts --out "$SCRATCH" \
     reload \
     'eval:(() => { const e = document.querySelector(".sidebar"); return { overflows: e.scrollHeight > e.clientHeight }; })()' \
     rest 'shot:rest@.sidebar' \
     hover:.sidebar 'shot:hover@.sidebar'
   ```

   Read the PNGs. A blank frame is a failed launch, not a passing test. For
   hover-only styling, also assert the computed value rather than trusting the
   image: `eval:getComputedStyle(document.querySelector(".sidebar")).scrollbarColor`.

5. **Stop it by data dir, never by app name** — `pkill -f "Ateam"` kills the
   developer's production app and any sibling worktree's dev instance:

   ```bash
   pkill -f "user-data-dir=$SCRATCH/udata"
   ```

## Gotchas this encodes

- **A dev instance may already be running** from a sibling worktree, sharing
  `~/Library/Application Support/@ateam/desktop`. The isolated `--user-data-dir`
  is what keeps both that session and the real data out of the blast radius.
  There is no single-instance lock, so a second instance starts fine.
- **`bun install` in a fresh worktree can fetch the wrong-arch `better-sqlite3`**
  and the app dies at startup with `ERR_DLOPEN_FAILED`. `launch.sh` checks and
  runs `bun run rebuild` (electron-rebuild against Electron's ABI).
- **Seeded tasks point at paths that don't exist.** Deliberate: the board
  reconciler's `git`/`gh` probes throw and are swallowed, so seeding stays
  offline and touches no real repo.
- **Screenshots alone can't prove `:hover`.** The macOS pointer is elsewhere;
  CDP's `Input.dispatchMouseEvent` is what actually sets the hover state.
