# Source before pulumi commands:  . ./creds.sh
# AWS_PROFILE (default: "default") should be a credential_process profile (e.g. derived from SSO login)
# (refreshed by `aws login`), so the AWS SDK/Pulumi provider fetches fresh
# credentials on demand and long deploys do not expire mid-flight.
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_CREDENTIAL_EXPIRATION
export AWS_PROFILE=${AWS_PROFILE:-default}
if ! aws sts get-caller-identity --query Arn --output text; then
    echo "Session expired -> run 'aws login --profile default' (finish in the browser), then re-source this file."
    return 1 2>/dev/null || exit 1
fi
