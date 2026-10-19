# Source me. Helpers to call the in-cluster Factory API from a laptop (port-forward + service-account bearer token).
# Requires: KUBECONFIG, kubectl, curl, python3. Never prints credentials.
#   factory_up            start port-forward, sign in; sets FB (base url) and FA (auth header)
#   factory_down          stop the port-forward
#   fcurl <curl args...>  curl with the auth header; path is relative to /web/factory via fapi
#   fapi METHOD PATH [JSON]   -> prints "<body>\nHTTP <code>"
factory_up() {
  local ns=${NS:-agent-platform} origin=${FACTORY_ORIGIN:-http://localhost:4111} i
  FPORT=${FPORT:-$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')}
  kubectl port-forward -n "$ns" svc/factory "$FPORT:4111" >/dev/null 2>&1 & FPF=$!
  FB=http://127.0.0.1:$FPORT
  for i in $(seq 1 30); do curl -sf "$FB/health" >/dev/null 2>&1 && break; sleep 1; done
  local email pw
  email=$(kubectl get secret factory-service-account -n "$ns" -o jsonpath='{.data.FACTORY_USER_EMAIL}' | base64 -d)
  pw=$(kubectl get secret factory-service-account -n "$ns" -o jsonpath='{.data.FACTORY_USER_PASSWORD}' | base64 -d)
  local tok
  tok=$(curl -s -X POST "$FB/auth/api/sign-in/email" -H 'content-type: application/json' -H "origin: $origin" \
        -d "$(EMAIL=$email PW=$pw python3 -c 'import json,os;print(json.dumps({"email":os.environ["EMAIL"],"password":os.environ["PW"]}))')" \
        | python3 -c 'import json,sys;print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
  [ -n "$tok" ] || { echo "factory_up: sign-in failed (is the service account created? scripts/bootstrap-user.sh)" >&2; return 1; }
  FA="Authorization: Bearer $tok"
}
factory_down() { [ -n "${FPF:-}" ] && kill "$FPF" 2>/dev/null; wait "$FPF" 2>/dev/null || true; FPF=; }
fapi() { # METHOD PATH [JSON]
  local m=$1 p=$2 d=${3:-}
  if [ -n "$d" ]; then curl -s -w '\nHTTP %{http_code}\n' -X "$m" -H "$FA" -H 'content-type: application/json' -d "$d" "$FB$p"
  else curl -s -w '\nHTTP %{http_code}\n' -X "$m" -H "$FA" "$FB$p"; fi
}
