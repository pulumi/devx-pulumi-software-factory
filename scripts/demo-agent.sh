#!/usr/bin/env bash
# Ask the in-cluster agent a question that needs its Factory tool. Prints the question and the agent's answer.
#   KUBECONFIG=<file> scripts/demo-agent.sh ["question"]
set -euo pipefail
NS=${NS:-agent-platform}; PORT=${LOCAL_PORT:-18080}
Q=${1:-"Use your tools to list the Factory projects and tell me how many work items the first project has."}
kubectl port-forward -n "$NS" svc/agent "$PORT:8080" >/dev/null 2>&1 & PF=$!
trap 'kill $PF 2>/dev/null; wait $PF 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 1; done
echo "you:   $Q"
curl -s --max-time 180 -X POST "http://127.0.0.1:$PORT/run" -H 'content-type: application/json' \
  -d "$(Q=$Q python3 -c 'import json,os;print(json.dumps({"prompt":os.environ["Q"]}))')" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print("agent: %s\n       (%s tool call%s, model: in-cluster)" % (d.get("text","").strip() or d.get("error"), d.get("toolCalls"), "" if d.get("toolCalls")==1 else "s"))'
