#!/usr/bin/env bash
# Run the Factory app locally (free) against a local Postgres, with the GitHub App from tools/github-app/.github-app.json.
# Same image code, auth (better-auth) and Postgres as the cluster; used to prove the GitHub link/intake before paying for a cluster.
#   scripts/local-factory.sh            (foreground; Ctrl-C to stop)   Needs Node 22 on PATH and Docker.
# Credentials go from the git-ignored file straight into this process's environment; nothing is printed.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT/apps/factory"
APP="$ROOT/tools/github-app/.github-app.json"; [ -f "$APP" ] || { echo "missing $APP (run tools/github-app/github-app.ts serve)" >&2; exit 1; }
npm run db:up >/dev/null
eval "$(node -e '
const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const q=(s)=>"\x27"+String(s).replace(/\x27/g,"\x27\\\x27\x27")+"\x27";
console.log("export GITHUB_APP_ID="+q(a.id)+" GITHUB_APP_SLUG="+q(a.slug)+" GITHUB_APP_CLIENT_ID="+q(a.client_id)+" GITHUB_APP_CLIENT_SECRET="+q(a.client_secret)+" GITHUB_APP_WEBHOOK_SECRET="+q(a.webhook_secret)+" GITHUB_APP_PRIVATE_KEY="+q(a.pem.replace(/\n/g,"\\n")));
' "$APP")"
export DATABASE_URL=postgres://user:pass@localhost:54329/mastracode_web
export FACTORY_CREDENTIAL_ENCRYPTION_KEY=${FACTORY_CREDENTIAL_ENCRYPTION_KEY:-$(openssl rand -base64 32)} FACTORY_CREDENTIAL_ENCRYPTION_KEY_ID=k1
export BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET:-$(openssl rand -base64 32)}
export PORT=4111 MASTRACODE_PUBLIC_URL=http://localhost:4111 FACTORY_SANDBOX_PROVIDER=local FACTORY_SIGNUP_ENABLED=1
export MASTRACODE_LOCAL_SANDBOX_ROOT=${TMPDIR:-/tmp}/factory-local-workspaces; mkdir -p "$MASTRACODE_LOCAL_SANDBOX_ROOT"
exec npm run dev
