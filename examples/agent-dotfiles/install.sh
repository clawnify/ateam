#!/bin/sh
# Install native agent files using chezmoi; no Ateam runtime is required.
set -eu

starter_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
starter_destination=${HOME:?HOME must identify the account running the agents}
starter_check=false
while [ "$#" -gt 0 ]; do
    case "$1" in
        --check) starter_check=true; shift ;;
        --destination)
            [ "$#" -ge 2 ] || { echo '--destination needs an existing directory' >&2; exit 2; }
            starter_destination=$2; shift 2 ;;
        *) echo "Usage: $0 [--check] [--destination DIRECTORY]" >&2; exit 2 ;;
    esac
done
starter_destination=$(CDPATH= cd -- "$starter_destination" && pwd -P)
# This starter targets the documented default layout. A redirected agent home
# needs an explicit mapping in the source tree rather than an unnoticed install.
if [ "$starter_destination" = "$(CDPATH= cd -- "$HOME" && pwd -P)" ]; then
    if [ "${CODEX_HOME:-$HOME/.codex}" != "$HOME/.codex" ] ||
       [ "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" != "$HOME/.claude" ] ||
       [ "${XDG_CONFIG_HOME:-$HOME/.config}" != "$HOME/.config" ] ||
       [ -n "${OPENCODE_CONFIG_DIR:-}" ]; then
        echo 'Custom agent directories detected. Adapt the home/ mappings before installing this starter.' >&2
        exit 1
    fi
fi
if ! command -v chezmoi >/dev/null 2>&1; then
    echo 'Install chezmoi 2.74.0 or newer on this box, then run again: https://www.chezmoi.io/install/' >&2
    exit 1
fi

# Keep this repository's apply history separate from an existing chezmoi setup.
# Explicit flags also keep --destination tests out of the real home directory.
set -- --source "$starter_root/home" --destination "$starter_destination" \
    --config /dev/null --config-format toml \
    --persistent-state "$starter_destination/.local/state/agent-dotfiles/chezmoistate.boltdb" \
    --cache "$starter_destination/.cache/agent-dotfiles" \
    --less-interactive --error-on-conflict --no-tty --no-pager --color=false

# Preflight every managed file before writing any of them. A pre-existing or
# locally changed target must be reconciled by the owner, never forced through.
if ! chezmoi "$@" apply --dry-run; then
    echo 'Nothing applied. Reconcile the conflicting file or unsupported layout, then retry.' >&2
    exit 1
fi
chezmoi "$@" diff
if [ "$starter_check" = true ]; then
    echo 'Check complete; no agent files changed.'
    exit 0
fi
chezmoi "$@" apply
echo 'Agent instructions and skills applied. Start a new agent session to load them.'
