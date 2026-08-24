#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root/services/cdk"

export AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-west-2}}"

cat <<EOF
This creates the account-wide API Gateway -> CloudWatch Logs IAM role
(AWS::ApiGateway::Account) in $AWS_REGION. It is a one-time, account-level
setting shared by every stack and every repo in this AWS account -- it is
not specific to any Auto Harness environment, and running this again is a
harmless no-op. It is additive only: it does not touch any existing stack,
and both the IAM role and the account resource are retained if this stack
is ever destroyed, so no other stack's access logging is affected.

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

pnpm exec cdk deploy \
  --app "node src/apigateway-account-cli.ts" \
  ApiGatewayAccount \
  --require-approval never
