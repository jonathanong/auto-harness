#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root/services/cdk"

export AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
if [[ -z "$AWS_REGION" ]]; then
  echo "AWS_REGION or AWS_DEFAULT_REGION is required" >&2
  exit 1
fi

cat <<EOF
This creates the account-wide API Gateway -> CloudWatch Logs IAM role
(AWS::ApiGateway::Account) in $AWS_REGION. It is a one-time, account-level
setting shared by every stack and every repo in this AWS account -- it is
not specific to any Auto Harness environment, and running this again is a
harmless no-op. Both the IAM role and the account resource are retained if
this stack is ever destroyed, so no other stack's access logging is affected.

This also runs 'cdk bootstrap', which creates or updates the shared
CDKToolkit stack in this account/region if one isn't already present or is
out of date. That is the only other resource this script touches; no
application stack in this account is modified.

After this succeeds, opt individual deploys into API Gateway access logs
with:
  HARNESS_ACCESS_LOGS_ENABLED=1 pnpm deploy:aws
EOF

if [[ -t 0 ]]; then
  read -r -p "Continue? [y/N] " answer
  if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
    echo "Cancelled." >&2
    exit 1
  fi
fi

if ! existing_role_arn="$(aws apigateway get-account --region "$AWS_REGION" \
  --query 'cloudwatchRoleArn' --output text)"; then
  echo "Failed to inspect the existing API Gateway account configuration in" >&2
  echo "$AWS_REGION. Refusing to continue without confirming whether a" >&2
  echo "CloudWatch Logs role is already configured there." >&2
  exit 1
fi
if [[ -n "$existing_role_arn" && "$existing_role_arn" != "None" \
  && "$existing_role_arn" != *AutoHarnessApiGatewayAccount* ]]; then
  cat >&2 <<EOF
A CloudWatch Logs role is already configured for API Gateway in
$AWS_REGION, and it was not created by this script:
  $existing_role_arn

This is an AWS-account-wide singleton. Deploying this stack would silently
replace it, breaking access logging for whatever other stack or repository
currently owns it. Refusing to continue.

If you have verified it is safe to replace (e.g. it is orphaned, or you also
own the other stack), remove or re-point it manually before retrying.
EOF
  exit 1
fi

account="$(aws sts get-caller-identity --query Account --output text)"
pnpm exec cdk bootstrap "aws://$account/$AWS_REGION"

pnpm exec cdk deploy \
  --app "node src/apigateway-account-cli.ts" \
  AutoHarnessApiGatewayAccount \
  --require-approval never
