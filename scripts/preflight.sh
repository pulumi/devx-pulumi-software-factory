#!/usr/bin/env bash
# Read-only environment check. Makes no changes.
set -uo pipefail
ok=0; bad=0
chk() { if eval "$2" >/dev/null 2>&1; then printf "ok   %s\n" "$1"; ok=$((ok+1)); else printf "FAIL %s\n" "$1"; bad=$((bad+1)); fi; }
for t in pulumi node npm python3.12 docker kubectl helm aws gh; do chk "tool: $t" "command -v $t"; done
chk "node >= 20" "node -e 'process.exit(+process.versions.node.split(\".\")[0] >= 20 ? 0 : 1)'"
chk "docker daemon" "docker info"
chk "aws identity" "aws sts get-caller-identity"
chk "pulumi login" "pulumi whoami"
chk "gh auth" "gh auth status"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}}"
echo "region: $REGION"
# g6.2xlarge offering + on-demand G/VT vCPU quota (L-DB2E81BA)
chk "g6.2xlarge offered in $REGION" "aws ec2 describe-instance-type-offerings --region $REGION --filters Name=instance-type,Values=g6.2xlarge --query 'InstanceTypeOfferings[0]' --output text | grep -q g6"
q=$(aws service-quotas get-service-quota --region "$REGION" --service-code ec2 --quota-code L-DB2E81BA --query Quota.Value --output text 2>/dev/null || echo 0)
echo "On-Demand G/VT vCPU quota: $q (need >= 16 for 2x g6.2xlarge)"
awk -v q="$q" 'BEGIN{exit !(q+0>=16)}' && ok=$((ok+1)) || { echo "FAIL quota"; bad=$((bad+1)); }
[ -f .env ] && echo "ok   .env present" || echo "note .env missing (needed: HF_TOKEN for the llm stack, JEV_* for the triage stack)"
echo "passed=$ok failed=$bad"; exit $((bad>0))
