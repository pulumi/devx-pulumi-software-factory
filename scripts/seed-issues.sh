#!/usr/bin/env bash
# Add work items to the demo project's Factory Intake, one per line from stdin (items.txt: 3 good, 1 duplicate, 1 out-of-scope, 1 vague).
# Idempotent (skips titles that already exist). Creates Factory work items only; no GitHub writes.
#   KUBECONFIG=<file> scripts/seed-issues.sh [project-name] < items.txt
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/factory.sh
PROJ=${1:-agent-factory-demo}
factory_up; trap factory_down EXIT
PID=$(fapi GET /web/factory/projects | head -1 | python3 -c 'import sys,json;n="'"$PROJ"'";p=[x for x in json.load(sys.stdin)["projects"] if x["name"]==n];print(p[0]["id"] if p else "")')
[ -n "$PID" ] || { echo "project '$PROJ' not found (run scripts/bootstrap.ts first)"; exit 1; }
EXISTING=$(fapi GET /web/factory/projects/$PID/work-items | head -1 | python3 -c 'import sys,json;print("\n".join(w["title"] for w in json.load(sys.stdin)["workItems"]))')
add() { # title  (note: order matters, the duplicate must come after its original)
  if printf '%s\n' "$EXISTING" | grep -qxF "$1"; then echo "  exists : $1"; return; fi
  fapi POST /web/factory/projects/$PID/work-items "{\"title\":$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1")}" | tail -1 | sed "s|^|  created ($1): |" | sed -E 's/ \(.*\): HTTP/: HTTP/'
  sleep 1   # distinct createdAt so duplicate detection can order them
}
[ -t 0 ] && { echo "usage: scripts/seed-issues.sh [project-name] < items.txt   (one title per line; order matters: a duplicate must come after its original)" >&2; exit 2; }
while IFS= read -r line; do [ -n "$line" ] && add "$line"; done
echo "seeded project '$PROJ'"
