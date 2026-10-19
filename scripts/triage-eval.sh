#!/usr/bin/env bash
# Live triage evaluation: 5 hand-made issues -> real Jev + real Factory. Prints decisions/confidences.
#   scripts/triage-eval.sh            dry-run only (no Factory writes)
#   scripts/triage-eval.sh --apply    then also run for real and show resulting stages
# Needs: KUBECONFIG (cluster up), Node 22 on PATH, agentcon/.env with TYPESAFE_API_KEY.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/factory.sh
factory_up; trap factory_down EXIT
PROJ=triage-eval
PID=$(fapi GET /web/factory/projects | head -1 | python3 -c 'import sys,json;n="'$PROJ'";p=[x for x in json.load(sys.stdin)["projects"] if x["name"]==n];print(p[0]["id"] if p else "")')
[ -n "$PID" ] || PID=$(fapi POST /web/factory/projects "{\"name\":\"$PROJ\",\"description\":\"triage evaluation\"}" | head -1 | python3 -c 'import sys,json;print(json.load(sys.stdin)["project"]["id"])')
add() { fapi POST /web/factory/projects/$PID/work-items "{\"title\":$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1")}" >/dev/null; }
EXISTING=$(fapi GET /web/factory/projects/$PID/work-items | head -1 | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["workItems"]))')
if [ "$EXISTING" = 0 ]; then
  add "Add a typing indicator that shows when another user in the session is typing"          # clear feature
  add "Messages sent while the websocket is reconnecting are silently lost; queue and resend them"  # clear bug
  add "Show a 'user is typing...' hint when someone else in the chat is typing"             # duplicate of #1
  add "Migrate the company payroll system to SAP"                                           # out of scope
  add "Make it better"                                                                      # vague
fi
export FACTORY_INTERNAL_URL=$FB TRIAGE_PROJECT=$PROJ LOOP_PROMPT_PATH=$PWD/factory-prompt.md WIP_LIMIT=${WIP_LIMIT:-10}
export FACTORY_USER_EMAIL=$(kubectl get secret factory-service-account -n agent-platform -o jsonpath='{.data.FACTORY_USER_EMAIL}' | base64 -d)
export FACTORY_USER_PASSWORD=$(kubectl get secret factory-service-account -n agent-platform -o jsonpath='{.data.FACTORY_USER_PASSWORD}' | base64 -d)
cd apps/triage
echo "== dry-run pass"; TRIAGE_DRY_RUN=true npx tsx src/live.ts
if [ "${1:-}" = "--apply" ]; then
  echo "== applying"; TRIAGE_DRY_RUN=false npx tsx src/live.ts
  echo "== resulting stages"; fapi GET /web/factory/projects/$PID/work-items | head -1 | python3 -c 'import sys,json
for w in json.load(sys.stdin)["workItems"]: print("  %-9s %s" % (w["stages"][-1], w["title"][:70]), "(needsHuman)" if (w.get("metadata") or {}).get("triage",{}).get("needsHuman") else "")'
fi
