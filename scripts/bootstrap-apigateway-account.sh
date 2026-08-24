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

After this succeeds, opt into API Gateway access logs:
  - existing environment: HARNESS_ACCESS_LOGS_ENABLED=1 pnpm deploy:aws
  - new environment's first deploy: pnpm deploy:aws runs the update flow,
    which refuses to run without an existing foundation stack, so set
    HARNESS_ACCESS_LOGS_ENABLED=1 before its
    'pnpm --filter @auto-harness/cdk run deploy' instead
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

if [[ -n "$existing_role_arn" && "$existing_role_arn" != "None" ]]; then
  role_name="${existing_role_arn##*/}"
  if ! aws iam get-role --role-name "$role_name" >/dev/null 2>&1; then
    cat >&2 <<EOF
The API Gateway account in $AWS_REGION points at an IAM role that no longer
exists:
  $existing_role_arn

This looks like drift from outside this stack (e.g. the role was deleted
manually). Re-running this script will not repair it: the CDK template is
unchanged, so 'cdk deploy' has nothing to update and would report success
without restoring a usable role.

Delete the AutoHarnessApiGatewayAccount stack (or otherwise clear the
account-level role) out of band before retrying, so this script has a real
create to perform.
EOF
    exit 1
  fi
fi

account="$(aws sts get-caller-identity --query Account --output text)"
pnpm exec cdk bootstrap "aws://$account/$AWS_REGION"

pnpm exec cdk deploy \
  --app "node src/apigateway-account-cli.ts" \
  AutoHarnessApiGatewayAccount \
  --require-approval never

final_role_arn="$(aws apigateway get-account --region "$AWS_REGION" \
  --query 'cloudwatchRoleArn' --output text)"
if [[ -z "$final_role_arn" || "$final_role_arn" == "None" ]]; then
  cat >&2 <<EOF
'cdk deploy' reported success, but the API Gateway account in $AWS_REGION
still has no CloudWatch Logs role configured.

This happens when the AutoHarnessApiGatewayAccount stack already exists with
an unchanged template (e.g. the account's role was cleared out of band):
CloudFormation sees no template diff and skips reasserting the account
resource's properties, so the deploy is a silent no-op.

Force it to reapply with:
  pnpm exec cdk deploy --app "node src/apigateway-account-cli.ts" \\
    AutoHarnessApiGatewayAccount --require-approval never --force
EOF
  exit 1
fi
