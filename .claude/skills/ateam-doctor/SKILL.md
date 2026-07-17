---
name: ateam-doctor
description: Post-restart health check for Claude Code sessions + Ateam release readiness. Run when the user says sessions are "gone" / "no conversation found" after a restart, asks whether anything was lost, wants to check backup health, or before cutting a release. Answers "you're fine" vs "here's what's genuinely lost + restore it".
---

# Ateam doctor

One command after a restart (or before a release) that tells the user plainly whether anything was **actually** lost or the app is just showing a blank/"no conversation" terminal.

## Run it

```bash
bash .claude/skills/ateam-doctor/doctor.sh
# optional: also check one worktree resumes
bash .claude/skills/ateam-doctor/doctor.sh <worktree-path>
```

Read-only. Reports five things:
1. **Transcripts** — live session count + most recent.
2. **Genuine recent losses** — sessions missing/truncated live but present in the backup **and** backed up in the last 72h (real crash victims, not old deletions). Old missing sessions are ignored on purpose.
3. **Backup** — is the launchd agent (`com.pallaoro.claude-projects-backup`) loaded, and how fresh is `~/.claude-backups`.
4. **Release readiness** — Developer ID cert (`X2VZX44YM2`) + `ateam-notary` profile present.
5. **Resume check** (with a worktree arg) — confirms a resumable transcript exists so `claude --continue` will work.

## Interpreting

- **Section 2 says "nothing lost recently"** → the sessions are intact on disk; a blank terminal is the resume UX: `--continue` silently reopens the session (loads history without replaying it), so it *looks* empty. If the user then opens `/resume`, it lists the session but picking it returns **"Resume cancelled"** — a concurrency guard, because that session is the one they're already running (Claude won't attach one conversation to two live processes). Nothing to recover — they were in the conversation the whole time; just type. Reassure.
- **Section 2 lists sessions** → those are genuinely lost live but recoverable. Restore them:
  ```bash
  bash .claude/skills/ateam-doctor/doctor.sh --restore-recent
  ```
  It copies the recent lost transcripts from `~/.claude-backups` back into `~/.claude/projects` (never overwrites a good live file). Then `claude --continue` in that worktree resumes them.
- **Release section shows ✗** → fix before running `/release` (see the `release` skill's §0 recovery for the cert/notary steps).

## Why this exists

The recurring "sessions gone after restart" scare is almost always **not** data loss — `claude` doesn't fsync transcripts, so the app's live view can look empty right after an unclean reboot, but the `.jsonl` files (and the 15-min backup) are intact. This skill settles it in seconds instead of a forensic dig. Backup + launchd live in dotfiles (machine-level, all projects); the `release` skill lives in dotfiles (it names the Apple ID).
