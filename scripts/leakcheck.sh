#!/usr/bin/env bash
# Fail if any non-trivial value from .env appears in tracked/untracked repo files or the working tree.
set -euo pipefail
cd "$(dirname "$0")/.."
ENVFILE=.env; [ -f "$ENVFILE" ] || ENVFILE=../.env
[ -f "$ENVFILE" ] || { echo "leakcheck: no .env, nothing to compare against"; exit 0; }
fail=0
while IFS='=' read -r key val; do
  [[ -z "${key// }" || "$key" =~ ^# ]] && continue
  val="${val%\"}"; val="${val#\"}"
  [ "${#val}" -ge 8 ] || continue
  if grep -rIlF --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=venv --exclude-dir=.venv --exclude=.env -- "$val" . >/dev/null 2>&1; then
    echo "LEAK: value of $key appears in:"; grep -rIlF --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=venv --exclude-dir=.venv --exclude=.env -- "$val" . | sed 's/^/  /'
    fail=1
  fi
done < "$ENVFILE"
# generic token patterns (file names only, so a real hit never echoes the secret).
# AKIA pattern skips AWS's published example key (AKIAIOSFODNN7EXAMPLE).
hits=$(grep -rIlE --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=venv --exclude-dir=.venv --exclude-dir=.mastra --exclude=.env --exclude=.env.example --exclude=.env.schema --exclude=leakcheck.sh \
  -e 'gh[pousr]_[A-Za-z0-9]{30,}' -e 'hf_[A-Za-z0-9]{30,}' -e 'AKIA[0-9A-HJ-Z][0-9A-Z]{15}' -e '-----BEGIN [A-Z ]*PRIVATE KEY' . || true)
if [ -n "$hits" ]; then echo "SUSPECT token pattern in:"; echo "$hits" | sed 's/^/  /'; fail=1; fi
[ "$fail" -eq 0 ] && echo "leakcheck: clean"
exit "$fail"
