#!/bin/bash
# Fill a throwaway Ateam database with a demo project and N tasks, so list-shaped
# UI (sidebar overflow, board columns, agent-status dots) can be seen without
# creating real worktrees.
#
#   bash .claude/skills/run-desktop/seed-tasks.sh <data-dir>/ateam.sqlite [count]
#
# Launch the app ONCE first so it creates the schema, quit it, then seed and
# relaunch (or reload the renderer over CDP). Worktree paths are fake on purpose:
# the board reconciler's git/gh probes throw and are swallowed, so seeding costs
# no network and touches no real repo.
set -e

DB="${1:?usage: seed-tasks.sh <path/to/ateam.sqlite> [count]}"
COUNT="${2:-45}"
[ -f "$DB" ] || { echo "no db at $DB — launch the app once to create it"; exit 1; }

PID=$(sqlite3 "$DB" "select id from projects limit 1;")
NOW=$(python3 -c 'import time;print(int(time.time()*1000))')
if [ -z "$PID" ]; then
  PID=$(uuidgen)
  sqlite3 "$DB" "insert into projects (id,repo_path,name,default_branch,worktrees_root,color,last_opened_at,created_at)
                 values ('$PID','/tmp/ateam-demo','demo','main','/tmp/ateam-demo/.wt','#6ee7b7',$NOW,$NOW);"
fi

# Cycle columns and agent statuses so every visual state is represented.
COLS=(todo running review merged todo running review)
STATUSES=("idle" "running" "needs_attention" "awaiting_input" "review" "stopped" "")

i=0
while [ "$i" -lt "$COUNT" ]; do
  slug="seeded-task-$i"
  col=${COLS[$((i % 7))]}
  st=${STATUSES[$((i % 7))]}
  sqlite3 "$DB" "insert into tasks (id,project_id,name,slug,branch,base_branch,worktree_path,\"column\",agent_status,agent_id,created_by,created_at,updated_at,last_event_at)
                 values ('$(uuidgen)','$PID','seeded task $i','$slug','$slug','main','/tmp/ateam-demo/.wt/$slug','$col',
                 $([ -z "$st" ] && echo NULL || echo "'$st'"),'claude','ateam',$NOW,$NOW,$((NOW - i * 1000)));"
  i=$((i + 1))
done

echo "seeded $COUNT tasks into project $PID (total: $(sqlite3 "$DB" 'select count(*) from tasks;'))"
