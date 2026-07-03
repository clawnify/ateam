# Agent-driven loops — design

Status: **foundation landed** (`agent-loop.ts` + tests). Bindings pending.
Grounded against primary-source docs 2026-07-03 (links inline).

## Two different things are both called "loops" — keep them apart

| | Reconciler loop (shipped, v1) | Agent loop (this design) |
|---|---|---|
| What runs | an app-side timer | the **agent itself**, another turn |
| Touches the agent? | never | that's the whole point |
| Examples | board-reconciler, auto-merge-when-green, pr-ci-watcher | "keep fixing tests until green", TODO burndown |
| Owns | `LoopRunner` + `loops` table | this doc |

The v1 `LoopRunner` stays exactly as-is for reconcilers. Agent loops are **not**
a second scheduler — see below.

## Why we do NOT build a scheduler for agent loops

The deferred-v1 note said agent loops "need headless exec because the registry
is interactive-PTY only." That was the wrong turn. Every agent we target already
exposes a **native** way to keep going after a turn — building an external clock
that re-injects prompts into the TUI reinvents a primitive the host already
owns (and the one PTY-injection path we considered is undocumented and fragile
on all three). So the rule is: **delegate execution to each agent's native seam;
share only the decision.**

## The one thing that IS shared: the decision (`agent-loop.ts`)

`decideContinuation(config, state, lastOutput?)` — pure, agent-agnostic:

- stop if the prompt is blank,
- **stop at the iteration cap** (mandatory backstop — no agent guarantees
  termination for us; see notes below),
- stop if the goal sentinel appears in the last turn's output,
- else continue, re-sending the configured prompt.

`AgentLoopConfig { prompt, maxIterations?, stopSignal? }` is persisted as the
loop row's `config` JSON and reused by every binding.

## The provider matrix — one concept, three native bindings

There is **no single native mechanism common to all three agents**, which is
exactly what justifies a thin per-agent adapter (the greybeard-`install.js` /
`agent-setup` pattern) and nothing more.

| Agent | Native seam | Ateam already has | Binding |
|---|---|---|---|
| **Claude Code** | native `/loop` skill (self-paced; carries into backgrounded sessions) — [docs](https://code.claude.com/docs/en/scheduled-tasks.md) | launch args / PTY | Launch the session with `/loop <prompt>`. Cadence + self-pacing live in the agent; Ateam holds the record + a hard cap. The Stop-hook "continue" is **undocumented** for Claude, so we use the native command, not a hook. |
| **Codex** | `Stop` hook returns `{"decision":"block","reason":"…"}` to keep going — [docs](https://developers.openai.com/codex/hooks) (its in-session `/loop`/cron is only [proposed #25466](https://github.com/openai/codex/issues/25466), **not shipped**) | writes `.codex/hooks.json` + runs the hook server | On `Stop`, a hook script GETs `/loop/decide` → server runs `decideContinuation` → returns `block`+prompt to continue, or allows the stop. **Zero PTY injection.** Lowest-effort native win. |
| **OpenCode** | `session.idle` plugin event + plugin API to inject a prompt (no native loop/cron at all) — [docs](https://opencode.ai/docs/plugins/); community proof: [opencode-loop](https://github.com/ByBrawe/opencode-loop) | plugin registration | A small plugin: on `session.idle`, call `/loop/decide`; if continue, inject the prompt. Same shared decision. |

The "brain" (continue? next prompt?) is one shared function; only the *binding*
differs — and for Codex/OpenCode the binding is a hook/plugin file Ateam already
knows how to write, so the cross-agent layer is cheap.

## Termination is mandatory (why the cap is not optional)

None of the three stops the loop for us:
- Codex docs: *"infinite loops would have to be prevented by your own logic."*
- Claude `/loop`: tasks expire only after **7 days**.
- OpenCode: no native stop.

So `decideContinuation` enforces an iteration cap **before** anything else, and
it's clamped to `HARD_MAX_ITERATIONS`. A user can also give a `stopSignal` for
early, goal-based exit — but the cap is the floor of safety.

## First loop (CHOSEN): the Board Organizer — Claude, write-capable

Decision (user, 2026-07-03): the first loop is a **dedicated Claude `/loop` that
reads AND mutates the board** through an Ateam board tool ("agent full
organizer"). Chosen over a deterministic reconciler because done-vs-ongoing
needs *judgment/context the reconciler misses* — see below. Accepted risk: an
LLM moving cards can misfile, so it runs behind two hard rails.

Architecture (mirrors the existing notify.sh / gh-shim pattern — agents talk to
the app over the localhost hook server; a thin MCP server wraps that as tools):

```
Claude /loop (organizer session)
   │  get_board  → hook-server /board/get     → rich per-task signals
   │  set_status → hook-server /board/set-status
   ▼
[MCP stdio server]  ── registered via agent-setup (like .claude hooks) ──┐
   │                                                                     │
   ▼                                                                     ▼
validateSetStatus (board-organizer.ts)  ◄── guardrail       triageWorktree (worktree-triage.ts)
   • never assign running/merged (ground truth)                • done-detection the agent reasons with
   • never move a card out of them                             • fed into get_board so the LLM sees context
   • never touch a live-agent card                             • NOT a merged-PR check
   • every move → audit BoardChange
```

### Done-detection — why the reconciler was wrong (`worktree-triage.ts` ✅)

The reconciler called tasks done from one thin signal (merged PR). The
`triage-worktrees` / `cleanup-worktrees` skills (pallaoro/dotfiles) encode the
real logic, now ported and tested here. `done` is true **only** when a PR is
genuinely merged/patch-equivalent AND the session wrapped up; every ongoing
signal is checked first and wins:

- recent activity (freshest of index/transcript/creation mtime) → in-flight;
- merged but transcript touched ≥ 4 min after `mergedAt` → conversation
  continued, not done;
- dirty / commits-ahead / open-PR → ongoing;
- patch-equivalence (`git cherry`) so squash/rebase merges aren't missed;
- no work yet ≠ done.

Callers gather signals (git/gh/stat/transcript mtime) and feed them to
`triageWorktree`; it stays pure. This is what `/board/get` surfaces so the
organizer LLM inherits the same context.

### Safety rail (`board-organizer.ts` ✅)

`validateSetStatus` gates every agent-proposed move: `running`/`merged` are
ground-truth (real events only), live-agent cards are untouchable, and each
approved move yields a `BoardChange` for an audit log. The agent proposes; this
disposes.

## Status detection — learn from `claude agents` (research 2026-07-03)

Claude Code does NOT infer agent status from lifecycle hooks (which is what
Ateam does, and why cards get stuck). Its supervisor maintains status by polling
`pid` + reading `~/.claude/jobs/<id>/state.json`, exposed via `claude agents
--json` with states `working | blocked | done | failed | stopped` and a
`waitingFor` field (`permission prompt` | `input needed`).

Lesson for Ateam: **poll `claude agents --json` / state.json as ground truth**
instead of relying on hooks alone. `waitingFor` distinguishes permission-block
from input-needed directly (no PreToolUse/Notification guessing), and the
polled state catches transitions hooks miss between fires — the exact failure
the board reconciler exists to patch. Fold this into `/board/get` and the
reconciler's liveness check.
[docs: agent-view.md, cli-reference.md `--json`]

## Column ownership (refined 2026-07-03)

- ASSIGNABLE (a tool caller may set): `todo`, `review`.
- PROGRAMMATIC (real events / hooks only, never a tool target): `running`
  (launch), `needs_attention` (**"requires input" is set programmatically by the
  input hooks, not judgment**), `merged` (real merge). "Done" is the display
  label for `merged`.

## Two tool callers (refined 2026-07-03)

The MCP tools are not organizer-only — a task's OWN session can move its OWN
card too (`if we have an mcp … the session itself could move the task status`):

- **Organizer** (external): re-triages among assignable columns; never touches a
  live-agent card or a programmatic column.
- **Self** (`bySelf`): the session bound to the card moves its own card (e.g.
  "I'm done" → `review`), allowed even while live; can't un-`merged`; can only
  move ITS OWN task. Identified by the caller's terminal id (an `x-ateam-
  terminal-id` header on the MCP request), audited as `source=session`.

Manual **Done button** (user authority, bypasses the guardrail): a review task's
terminal toolbar shows Done → `tasks.setColumn(id, "merged")` (emits an update).

## Build order

1. ✅ Shared brain + tests (`agent-loop.ts`).
2. ✅ Done-detection (`worktree-triage.ts`) + safety rail (`board-organizer.ts`).
3. ✅ `/board/get` + `/board/set-status` hook-server endpoints + `board-signals.ts`
   (`buildBoardView` runs `triageWorktree`; `applySetStatus` runs
   `validateSetStatus` + audit + caller resolution) + `board_changes` table.
4. ✅ Ateam board **MCP server** — served on the hook server's `/mcp` endpoint
   (Streamable HTTP: POST→JSON, GET→405, no SSE/SDK/subprocess needed;
   `board-mcp.ts`). Config helper `ensureBoardMcpConfig` (agent-setup) writes the
   `.mcp.json` for `claude --mcp-config`. **57 tests green.**
5. **Launch wiring + organizer loop** (next): pass `--mcp-config` +
   `--allowedTools mcp__ateam_board__*` when launching sessions (so a session can
   self-move) and the organizer (`LoopRunner` → headless `claude -p` per tick).
6. **Ateam skills, greybeard-style** (`and then we add a ateam skills like
   clawnify/greybeard`) — the "instruct" layer: ship per-agent skill/guidance
   files (via the provider matrix) teaching the agent WHEN to call the board
   tools ("when you finish, set_status → review"; the organizer's job). This is
   the greybeard `install.js` PROVIDERS pattern applied to Ateam's own skills —
   distribution layer on top of the MCP capability layer.
7. UI: show organizer moves + the `board_changes` audit trail in the Loops panel.

### Which engine drives the organizer — NOT Claude's `/loop`

Two loop families, two engines — don't conflate:

- **In-session code loops** ("keep fixing tests") live in a task's own pane and
  the agent self-paces → use Claude's **native `/loop`** (`agent-loop.ts`).
- **App-level judgment loops** (this organizer) are cross-task reconcilers with
  an LLM in the run step → use Ateam's **`LoopRunner`**, ticking a **headless
  `claude -p`** turn. Each tick: read board → re-triage → guarded moves → exit.

`-p` beats native `/loop` here on every axis: Ateam keeps cadence/enable/audit
(existing infra, no second scheduler); `-p` *documents* slash-command + MCP-tool
support (positional-slash in interactive mode is undocumented, and `--bg`
backgrounds with no pane + 7-day expiry); fresh context each tick suits a
reconciler (no multi-day drift/cost); clean one-turn lifecycle, no PTY
injection, no supervisor. The organizer is a reconciler whose judgment is
delegated to a headless turn — nothing more.

## Later: extract the provider matrix

The Codex (`Stop` block-and-continue) and OpenCode (`session.idle` plugin)
bindings are the same shape as `agent-setup/index.ts` and greybeard's
`bin/install.js` (detect agent → its hook/settings/event names). Once a second
binding exists, extract that seam into a small adapter — not a new runtime;
OpenClaw already is the runtime.
