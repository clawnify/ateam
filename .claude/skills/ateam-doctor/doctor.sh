#!/bin/bash
# ateam doctor — post-restart health check for Claude Code sessions + Ateam release readiness.
#
# Read-only by default. After an unclean restart it tells you plainly whether
# anything was ACTUALLY lost (vs the app just showing a blank/"no conversation"
# terminal), whether the backup is healthy, and whether a release can be cut.
#
#   bash doctor.sh                      full health report
#   bash doctor.sh <worktree-path>      + resume check for one worktree
#   bash doctor.sh --restore-recent     restore genuinely-lost recent sessions from backup
#
# Background: `claude` doesn't fsync its transcripts, so a hard reboot can wipe
# in-flight .jsonl from ~/.claude/projects. A launchd agent mirrors them to
# ~/.claude-backups every 15 min. `--continue` reads the transcript dir directly
# (so it resumes even when /resume's picker looks empty); a blank terminal on
# resume is Claude not replaying history, NOT data loss.
set -uo pipefail

LIVE="$HOME/.claude/projects"
BK="$HOME/.claude-backups/projects"
RECENT_H="${ATEAM_DOCTOR_RECENT_H:-72}"   # a loss newer than this = real crash victim, not an old deletion
LABEL="com.pallaoro.claude-projects-backup"
TEAM="X2VZX44YM2"

g(){ printf '  \033[32m✓\033[0m %s\n' "$1"; }
y(){ printf '  \033[33m!\033[0m %s\n' "$1"; }
r(){ printf '  \033[31m✗\033[0m %s\n' "$1"; }
h(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

# ---- restore mode -----------------------------------------------------------
if [ "${1:-}" = "--restore-recent" ]; then
  python3 - "$LIVE" "$BK" "$RECENT_H" <<'PY'
import os,glob,sys,time,shutil
live,bk,rh=sys.argv[1],sys.argv[2],float(sys.argv[3]); now=time.time(); n=0
for bf in glob.glob(bk+"/*/*.jsonl")+glob.glob(bk+"/*/*/*/*.jsonl"):
    rel=os.path.relpath(bf,bk); lf=os.path.join(live,rel)
    b=os.path.getsize(bf); l=os.path.getsize(lf) if os.path.exists(lf) else -1
    if (l==-1 or (b>2000 and l<b*0.5)) and (now-os.path.getmtime(bf))/3600 < rh:
        os.makedirs(os.path.dirname(lf),exist_ok=True); shutil.copy2(bf,lf); n+=1
        print("  restored", rel)
print(f"\nrestored {n} session(s) from backup into ~/.claude/projects")
PY
  exit 0
fi

printf '\033[1m== ateam doctor ==\033[0m  %s\n' "$(date '+%Y-%m-%d %H:%M')"

# ---- 1. transcripts ---------------------------------------------------------
h "1. Transcripts (live)"
ln=$(find "$LIVE" -name '*.jsonl' -size +1k 2>/dev/null | wc -l | tr -d ' ')
g "$ln sessions with content"
nw=$(find "$LIVE" -name '*.jsonl' -exec stat -f '%m %N' {} \; 2>/dev/null | sort -rn | head -1)
[ -n "$nw" ] && g "most recent: $(date -r "${nw%% *}" '+%Y-%m-%d %H:%M')  ($(basename "$(dirname "${nw#* }")" | sed 's/.*worktrees-//' | cut -c1-45))"

# ---- 2. genuine recent losses ----------------------------------------------
h "2. Genuine recent losses (last ${RECENT_H}h)"
python3 - "$LIVE" "$BK" "$RECENT_H" <<'PY'
import os,glob,sys,time
live,bk,rh=sys.argv[1],sys.argv[2],float(sys.argv[3]); now=time.time(); hits=[]
for bf in glob.glob(bk+"/*/*.jsonl")+glob.glob(bk+"/*/*/*/*.jsonl"):
    rel=os.path.relpath(bf,bk); lf=os.path.join(live,rel)
    b=os.path.getsize(bf); l=os.path.getsize(lf) if os.path.exists(lf) else -1
    if (l==-1 or (b>2000 and l<b*0.5)) and (now-os.path.getmtime(bf))/3600 < rh:
        hits.append((rel,b,os.path.getmtime(bf)))
if not hits:
    print("  \033[32m✓\033[0m nothing lost recently — all recent sessions intact on disk")
    print("    (a blank/\"no conversation\" terminal is the resume UX, not data loss)")
else:
    print("  \033[31m✗\033[0m %d session(s) genuinely lost, recoverable from backup:"%len(hits))
    for rel,b,mt in sorted(hits,key=lambda x:-x[2]):
        proj=rel.split('/')[0].split('worktrees-')[-1][:45]
        print("     %s  %dKB  %s"%(time.strftime('%m-%d %H:%M',time.localtime(mt)),b//1024,proj))
    print("    restore with:  bash doctor.sh --restore-recent")
PY

# ---- 3. backup health -------------------------------------------------------
h "3. Backup"
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  g "launchd agent loaded (runs every 15 min + on login)"
else
  r "backup agent NOT loaded — run ~/dotfiles/install.sh"
fi
bn=$(find "$BK" -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')
bnw=$(find "$BK" -name '*.jsonl' -exec stat -f '%m' {} \; 2>/dev/null | sort -rn | head -1)
if [ -n "$bnw" ]; then
  age=$(( ( $(date +%s) - bnw ) / 60 ))
  if [ "$age" -lt 30 ]; then g "$bn files backed up; newest ${age}m ago"; else y "$bn files backed up; newest ${age}m ago (agent may be between runs)"; fi
else
  r "backup empty or missing at $BK"
fi

# ---- 4. release readiness ---------------------------------------------------
h "4. Release readiness"
if security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application.*$TEAM"; then
  g "Developer ID signing cert present ($TEAM)"
else
  r "Developer ID cert MISSING — /release preflight will fail (see /release §0 recovery)"
fi
if xcrun notarytool history --keychain-profile ateam-notary >/dev/null 2>&1; then
  g "notary profile 'ateam-notary' works"
else
  r "notary profile missing — xcrun notarytool store-credentials ateam-notary --apple-id pallaororm@gmail.com --team-id $TEAM (pw in Doppler scope Ateam)"
fi
y "signing-key backup: keep a .p12 of the Developer ID cert in Doppler — a crash can't reconstruct the key"

# ---- 5. optional per-worktree resume check ---------------------------------
if [ -n "${1:-}" ] && [ -d "$1" ]; then
  h "5. Resume check: $1"
  slug=$(printf '%s' "$(cd "$1" && pwd -P)" | sed 's|[/.]|-|g')
  d="$LIVE/$slug"
  f=$(ls -t "$d"/*.jsonl 2>/dev/null | head -1)
  if [ -n "$f" ] && [ "$(stat -f %z "$f")" -gt 1024 ]; then
    g "resumable: $(($(stat -f %z "$f")/1024))KB transcript present — \`claude --continue\` here will resume it"
  else
    r "no resumable transcript for this worktree at $d"
  fi
fi
echo
