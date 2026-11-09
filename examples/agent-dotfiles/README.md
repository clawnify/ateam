# Portable agent dotfiles starter

Personal instructions and one reusable review skill for Claude Code, Codex, and
OpenCode. This is a small [chezmoi](https://www.chezmoi.io/) repository you can copy
and own, using the agents' native files and the [Agent Skills format](https://agentskills.io/).
It works from a terminal, Codespaces' install-script convention, or Ateam's per-box
Preview → Apply flow. It is an example, not a new cross-agent configuration standard.

The installer requires **chezmoi 2.74.0 or newer**, a POSIX shell, and a macOS or
Linux user home with the default agent directories. It does not install agent CLIs,
sign into providers, change permission settings, or require Ateam.

## Start with your own repository

Copy this directory's contents, including hidden files, into a new directory:

```sh
mkdir ../my-agent-dotfiles
cp -R examples/agent-dotfiles/. ../my-agent-dotfiles/
cd ../my-agent-dotfiles
```

Edit `home/.chezmoitemplates/instructions.md` and
`home/dot_agents/skills/review-changes/SKILL.md` to fit your work. Initialize a Git
repository, review its contents, and commit them with your own configured identity.
Keep `install.sh` executable in Git (`git update-index --chmod=+x install.sh`).
Push to a repository you control; private repositories work with the box's Git access.

Install [chezmoi](https://www.chezmoi.io/install/) on the destination machine first.
On macOS it is available through `brew install chezmoi`. The installer deliberately
does not download binaries or packages on your behalf.

From a clone on that machine, inspect the file diff and then install:

```sh
./install.sh --check
./install.sh
```

To inspect or test a disposable destination without changing your actual home:

```sh
mkdir -p /tmp/my-agent-dotfiles-home
./install.sh --check --destination /tmp/my-agent-dotfiles-home
./install.sh --destination /tmp/my-agent-dotfiles-home
```

`--check` runs a dry run and prints a diff. It does not change agent files. An
unchanged second install prints no diff. Local edits and pre-existing conflicting
files stop installation; the script never supplies `--force`.

## Apply from Ateam

1. Install chezmoi on the box and make it available on the engine's `PATH`.
2. On iOS, open **Boxes → the box's settings gear → Dotfiles**. On desktop, open
   the box's **Dotfiles** section.
3. Enter your dotfiles repository URL. Leave **Install script** empty when
   `install.sh` is at the repository root.
4. **Preview** checks out the repository and identifies its commit and executable
   install script. Inspect the checkout and run `./install.sh --check` in its
   terminal if you want the file-level diff before applying.
5. **Apply** runs that script on the selected box. The log contains the file diff
   and the install result. Start a new agent session to load the installed files.

Ateam Preview does not execute a script or predict arbitrary installer effects.
Saving a default does not install anything. A new preview is required for another
apply, including after a failed attempt.

## Files and discovery

All installed paths below are relative to the account running the agents.

| Source | Installed path | Reader |
|---|---|---|
| `home/.chezmoitemplates/instructions.md` via templates | `~/.claude/CLAUDE.md` | Claude Code |
| Same shared instructions | `~/.codex/AGENTS.md` | Codex |
| Same shared instructions | `~/.config/opencode/AGENTS.md` | OpenCode |
| `home/dot_agents/skills/review-changes/` | `~/.agents/skills/review-changes/` | Codex and OpenCode |
| `home/dot_claude/skills/symlink_review-changes` | `~/.claude/skills/review-changes` → the shared skill | Claude Code compatibility path |

There is one skill source. OpenCode also discovers Claude's compatibility path and
selects skills by ID; both paths here resolve to the same content. Keep skill names
unique when adding more. Supporting scripts and references belong beside `SKILL.md`.

The `.chezmoiroot` file points standard chezmoi commands at `home/`. The installer
uses an explicit source, an empty config, and its own persistent state at
`~/.local/state/agent-dotfiles/chezmoistate.boltdb`, leaving an existing chezmoi
configuration unchanged. The cache location is `~/.cache/agent-dotfiles`.
Use this wrapper consistently so the conflict history stays consistent.

## Existing setups and updates

If a target already contains different instructions, or an agent directory is a
symlink into an existing dotfiles repository, the preflight stops before changing
agent files. Merge the guidance into your existing source, or deliberately move
aside the conflicting file and preserve a backup before retrying. Do not remove
an entire agent directory: it may also contain credentials and session history.

If you already use chezmoi, you can instead integrate these sources into your own
repository and use your existing workflow. Choose one repository and state store
to manage each target. Do not apply both repositories to the same files.

To update, edit and commit the source, pull the new commit on the machine, and run
`./install.sh --check` followed by `./install.sh`. Ateam performs the fetch during
Preview. Changes made directly to installed files are treated as conflicts; bring
those edits back into the source before applying an update. Removing a source file
does not uninstall its old target. No automatic deletion or rollback is provided.

A preflight reduces partial updates caused by known conflicts; installation is
not transactional. A concurrent edit, disk failure, or a script you add can still
leave partial changes. Do not edit or run another installer during an apply.

## Boundaries of the convention

- **Personal preferences:** keep portable instructions and skills here.
- **Project instructions:** keep repository-specific `AGENTS.md` or `CLAUDE.md`
  and development environment definitions in that project's repository.
- **Agent settings:** keep native configuration semantics. If you add settings
  files, review their scope and permission behavior for each agent independently.
- **Credentials and state:** authenticate each machine separately. Do not copy
  whole `.claude`, `.codex`, or `.config/opencode` directories. Tokens, auth files,
  history, session databases, caches, and automatic memory are not starter content.
  The included `.gitignore` is a convenience, not a secret scanner.
- **Custom paths:** the wrapper refuses custom `CODEX_HOME`, `CLAUDE_CONFIG_DIR`,
  `XDG_CONFIG_HOME`, or `OPENCODE_CONFIG_DIR` when installing into the actual home.
  Adapt the source paths and corresponding guard for such a setup. `--destination`
  is for inspecting an alternate home, not configuring an agent to use it.
- **Scope:** local CLI environments on macOS/Linux. Native Windows, hosted agent
  sandboxes, and identical behavior across agent models are not promised.

There is no Ateam-specific manifest. The reusable parts are Git, a conventional
executable `install.sh`, chezmoi's existing source layout, and native agent files.

## Verify changes to this starter

From the Ateam checkout, with chezmoi on `PATH`:

```sh
REQUIRE_CHEZMOI_TESTS=1 bun test scripts/agent-dotfiles.test.ts
```

The checks use temporary destinations and real chezmoi. They cover dry runs,
repeat installs, credentials left untouched, source updates, pre-existing/local
conflicts, symlinked directories, and Ateam's actual Git clone/Preview/Apply path.
The dedicated CI job requires the dependency rather than silently skipping tests.
Without chezmoi, the ordinary repository test run skips this optional suite.

Agent discovery paths were checked against the official documentation:
[Claude instructions](https://code.claude.com/docs/en/memory),
[Claude skills](https://code.claude.com/docs/en/skills),
[Codex instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md),
[Codex skills](https://learn.chatgpt.com/docs/build-skills),
[OpenCode instructions](https://opencode.ai/docs/instructions/), and
[OpenCode skills](https://dev.opencode.ai/docs/skills/).
Policies or instruction overrides can still suppress or replace personal files;
check your agent's loaded instructions and skill list after installation.

## License

This starter is provided under [GPL-3.0-or-later](LICENSE), like Ateam.
