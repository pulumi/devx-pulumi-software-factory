#!/usr/bin/env bash
# Print the Factory board for a project as a terminal view: work items grouped by stage, with triage flags.
#   KUBECONFIG=<file> scripts/board.sh [project-name]
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/factory.sh
PROJ=${1:-agent-factory-demo}
factory_up; trap factory_down EXIT
PID=$(fapi GET /web/factory/projects | head -1 | python3 -c 'import sys,json;n="'"$PROJ"'";p=[x for x in json.load(sys.stdin)["projects"] if x["name"]==n];print(p[0]["id"] if p else "")')
[ -n "$PID" ] || { echo "project '$PROJ' not found"; exit 1; }
fapi GET /web/factory/projects/$PID/work-items | head -1 | python3 -c '
import sys, json
items = json.load(sys.stdin)["workItems"]
order = ["intake", "triage", "planning", "execute", "review", "done", "canceled"]
print("Factory board: %s" % "'"$PROJ"'")
for stage in order:
    col = [w for w in items if w["stages"][-1] == stage]
    if not col and stage not in ("intake", "planning", "canceled"): continue
    print("\n  %s (%d)" % (stage.upper(), len(col)))
    for w in sorted(col, key=lambda w: w["createdAt"]):
        t = (w.get("metadata") or {}).get("triage") or {}
        flag = ""
        if t: flag = "   <- jev: %s %.2f (%s)%s" % (t.get("decision"), t.get("confidence", 0), t.get("reason"), "  NEEDS HUMAN" if t.get("needsHuman") else "")
        print("    - %s%s" % (w["title"][:70], flag))
'
