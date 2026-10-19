#!/usr/bin/env bash
# Ensure the Factory service account (better-auth user) exists, using the credentials in the
# `factory-service-account` Secret. Idempotent; never prints the password.
# Usage: KUBECONFIG=<file> scripts/bootstrap-user.sh      (or: . stacks/llm/creds.sh with a kubeconfig set)
set -euo pipefail
NS=${NS:-agent-platform}; ORIGIN=${FACTORY_ORIGIN:-http://localhost:4111}; PORT=${LOCAL_PORT:-14111}
EMAIL=$(kubectl get secret factory-service-account -n "$NS" -o jsonpath='{.data.FACTORY_USER_EMAIL}' | base64 -d)
PASSWORD=$(kubectl get secret factory-service-account -n "$NS" -o jsonpath='{.data.FACTORY_USER_PASSWORD}' | base64 -d)
kubectl port-forward -n "$NS" svc/factory "$PORT:4111" >/dev/null 2>&1 & PF=$!
trap 'kill $PF 2>/dev/null; wait $PF 2>/dev/null || true' EXIT
B=http://127.0.0.1:$PORT
for _ in $(seq 1 30); do curl -sf "$B/health" >/dev/null 2>&1 && break; sleep 2; done
signin() { curl -s -o /dev/null -w '%{http_code}' -X POST "$B/auth/api/sign-in/email" -H 'content-type: application/json' -H "origin: $ORIGIN" \
  -d "$(EMAIL=$EMAIL PASSWORD=$PASSWORD python3 -c 'import json,os;print(json.dumps({"email":os.environ["EMAIL"],"password":os.environ["PASSWORD"]}))')"; }
if [ "$(signin)" = 200 ]; then echo "service account $EMAIL: already exists, sign-in OK"; exit 0; fi
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/auth/api/sign-up/email" -H 'content-type: application/json' -H "origin: $ORIGIN" \
  -d "$(EMAIL=$EMAIL PASSWORD=$PASSWORD python3 -c 'import json,os;print(json.dumps({"email":os.environ["EMAIL"],"password":os.environ["PASSWORD"],"name":"agent-svc"}))')")
[ "$code" = 200 ] || { echo "sign-up failed: HTTP $code (is FACTORY_SIGNUP_ENABLED=0, or does the user exist with another password?)"; exit 1; }
[ "$(signin)" = 200 ] && echo "service account $EMAIL: created, sign-in OK" || { echo "created but sign-in failed"; exit 1; }
