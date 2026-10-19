#!/usr/bin/env bash
# After teardown: list any AWS resources (tagged with our Owner) that belong to this project. Expect none.
#   . stacks/llm/creds.sh; scripts/aws-leftovers.sh [owner-email]
set -euo pipefail
OWNER=${1:?usage: aws-leftovers.sh <owner-tag-value>}
ARNS=$(aws resourcegroupstaggingapi get-resources --region us-east-1 --tag-filters "Key=Owner,Values=$OWNER" --query 'ResourceTagMappingList[].ResourceARN' --output text | tr '\t' '\n')
MINE=$(printf '%s\n' "$ARNS" | grep -E 'agent-factory|repository/(factory|agent|triage)|triage-decisions|dynamo' || true)
EBS=$(aws ec2 describe-volumes --region us-east-1 --filters "Name=status,Values=available" "Name=tag:Owner,Values=$OWNER" --query 'Volumes[].VolumeId' --output text)
echo "resources tagged Owner=$OWNER that belong to agent-factory:"
if [ -z "$MINE" ] && [ -z "$EBS" ]; then echo "  none - clean"; else printf '%s\n' "$MINE" "$EBS" | sed '/^$/d;s/^/  /'; exit 1; fi
