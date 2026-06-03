<h1 align="center">Ateam</h1>

<p align="center">
  Local-first orchestration for a crew of AI coding agents — Claude Code,
  OpenCode, and Codex — each isolated in its own git worktree.
</p>

<p align="center">
  <a href="https://github.com/clawnify/ateam/releases/latest">
    <img src="https://img.shields.io/badge/Download%20for%20macOS-111111?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS" height="44" />
  </a>
</p>

A lean, **local-first** desktop app to orchestrate a crew of AI coding agents
(Claude Code, OpenCode, Codex) in parallel — each isolated in its own **git
worktree**, organized by project, with built-in commit/push/pull/merge that
**never disturbs another worktree's checkout**, and a Mission Control grid to
watch several agents work at once.

No login, no cloud. Identity and all GitHub operations come from the `gh` CLI.

> **Builds:** macOS releases will be published on the
> [Releases](https://github.com/clawnify/ateam/releases) page. Until then, run
> from source (see [Develop](#develop)).

## Requirements

- **Bun** ≥ 1.3 (`brew install oven-sh/bun/bun`)
- **git** ≥ 2.31, **gh** (authenticated: `gh auth status`)
- At least one agent CLI on PATH: `claude`, `opencode`, or `codex`

> Note: if your `node` is x86_64 (Rosetta) while Bun + Electron are arm64, the
> desktop dev/build scripts run under Bun's runtime (`bunx --bun`) so the right
> native binaries are used. After `bun install`, native modules are rebuilt for
> Electron via `bun run --filter @grove/desktop rebuild`.

## Layout

```
packages/git-core   Safe worktree + git engine (no Electron, fully unit-tested)
packages/db         Local SQLite (Drizzle + better-sqlite3); bun:sqlite in tests
packages/agents     Agent registry (claude/opencode/codex) + availability probe
packages/panes      Pane/split layout types
apps/desktop        Electron + React app (main · preload · renderer)
```

## Develop

```bash
bun install
bun run --filter @grove/desktop rebuild   # native modules for Electron (arm64)
bun run --filter @grove/desktop dev        # launch the app (Electron + Vite HMR)
```

## Test & typecheck

```bash
bun test             # git-core + db
bun run typecheck    # all packages
bun run --filter @grove/desktop build      # production bundle
```

## How the safe git model works

- One worktree per task, co-located at `<repo>/.ateam/worktrees/<slug>` (excluded
  via `.git/info/exclude`, so it never pollutes the project's own status).
- **1 worktree : 1 branch** — we never `checkout`/`switch` a branch inside an
  existing worktree. Every mutation is `git -C <worktree>`-scoped.
- **Merge** goes through `gh pr merge` (remote-side, touches no local checkout),
  then auto-updates local `main` safely: a direct ref fast-forward when `main`
  isn't checked out anywhere, or `merge --ff-only` inside `main`'s own worktree
  when it is — aborting rather than clobbering if `main` diverged.

## Status

Working: project registration, worktree-per-task lifecycle, commit/push/update/
merge, diff, agent spawning in PTYs, hook-driven status → kanban columns,
Mission Control grid, and safe cleanup of merged worktrees. The git engine and
db layer are unit-tested; the Electron main process is boot-verified with native
modules.

## Roadmap

- Integrations (Linear / Slack / GitHub issues) with **no paywall** — exposed to
  every agent via MCP, brokered through Composio/Arcade.
- Session-history continuity across worktrees ("fork session").
- Signed + notarized macOS builds.

## License

Dual-licensed: **[GPL-3.0-or-later](./LICENSE)** for open source use — or a
**commercial license** for organizations that can't comply with the GPL
(contact [Clawnify](https://github.com/clawnify)). © 2026 Clawnify
