#!/usr/bin/env bash
# Model endpoint check: from INSIDE the cluster, hit the OpenAI-compatible endpoint:
#   /models, /chat/completions (non-empty), and a request with `tools` that must return a tool call.
# Reasoning models (Qwen3) spend tokens thinking before the visible answer, so max_tokens defaults to 1024 (override MAX_TOKENS).
# Usage: . stacks/llm/creds.sh && scripts/check-llm.sh
set -euo pipefail
cd "$(dirname "$0")/../stacks/llm"
# Inputs default to stack outputs; override with LLM_OPENAI_BASE_URL / LLM_MODEL / KUBECONFIG_FILE (e.g. mid-deploy).
BASE=${LLM_OPENAI_BASE_URL:-$(pulumi stack output llm_openai_base_url)}
MODEL=${LLM_MODEL:-$(pulumi stack output llm_model)}
kc=$(mktemp); trap 'rm -f "$kc"; kubectl --kubeconfig "$kc" delete pod llm-check -n default --ignore-not-found >/dev/null 2>&1 || true' EXIT
if [ -n "${KUBECONFIG_FILE:-}" ]; then cp "$KUBECONFIG_FILE" "$kc"; else pulumi stack output kubeconfig --show-secrets > "$kc"; fi
K="kubectl --kubeconfig $kc"

run() { # run <name> <curl args...> ; prints body
  $K run llm-check -n default --rm -i --restart=Never --quiet --image=curlimages/curl:8.10.1 --command -- \
    curl -sS --max-time 120 -w '\n%{http_code}' "$@"
}
fail() { echo "FAIL: $*"; exit 1; }

echo "== GET $BASE/models"
out=$(run "$BASE/models"); code=${out##*$'\n'}; body=${out%$'\n'*}
[ "$code" = 200 ] || fail "models returned $code"; echo "$body" | grep -q "$MODEL" || fail "model $MODEL not listed"; echo "ok (200, lists $MODEL)"

echo "== POST chat/completions"
payload=$(MODEL="$MODEL" python3 -c 'import json,os;print(json.dumps({"model":os.environ["MODEL"],"messages":[{"role":"user","content":"Reply with the single word: pong"}],"max_tokens":int(os.environ.get("MAX_TOKENS","1024"))}))')
out=$(run -H 'Content-Type: application/json' -d "$payload" "$BASE/chat/completions"); code=${out##*$'\n'}; body=${out%$'\n'*}
[ "$code" = 200 ] || fail "chat returned $code: $body"
echo "$body" | python3 -c 'import json,sys;r=json.load(sys.stdin);c=r["choices"][0]["message"]["content"];assert c and c.strip(),"empty completion";print("ok:",c.strip()[:80])'

echo "== POST chat/completions with tools (must return a tool call)"
payload=$(MODEL="$MODEL" python3 - <<'PY'
import json,os
print(json.dumps({"model":os.environ["MODEL"],"max_tokens":int(os.environ.get("MAX_TOKENS","1024")),"tool_choice":"auto",
 "messages":[{"role":"user","content":"What is the weather in Paris right now? Use the tool."}],
 "tools":[{"type":"function","function":{"name":"get_weather","description":"Get current weather for a city",
   "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]}))
PY
)
out=$(run -H 'Content-Type: application/json' -d "$payload" "$BASE/chat/completions"); code=${out##*$'\n'}; body=${out%$'\n'*}
[ "$code" = 200 ] || fail "tools request returned $code: $body"
echo "$body" | python3 -c '
import json,sys
m=json.load(sys.stdin)["choices"][0]["message"]
tc=m.get("tool_calls") or []
assert tc, "no tool_calls in response: %r" % (m,)
f=tc[0]["function"]; args=json.loads(f["arguments"])
assert f["name"]=="get_weather" and "city" in args, "unexpected tool call %r" % (f,)
print("ok: tool call", f["name"], args)'
echo "check-llm: all passed"
