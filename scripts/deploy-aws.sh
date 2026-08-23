#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

if [[ "${1:-}" == "--" ]]; then
  shift
fi

usage() {
  cat <<'EOF'
Usage: pnpm deploy:aws [--yes-first-ledger]

Fast-forwards a clean main checkout, installs the lockfile, and updates the AWS
control plane. The first SessionDrains ledger rollout is detected and gated
automatically; --yes-first-ledger is the non-interactive confirmation that
external session admission is already disabled and active sessions are idle.
EOF
}

confirm_first_ledger=0
case "${1:-}" in
  "") ;;
  --yes-first-ledger) confirm_first_ledger=1 ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

export AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-west-2}}"
export HARNESS_DEPLOY_ENVIRONMENT="${HARNESS_DEPLOY_ENVIRONMENT:-production}"

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "deploy:aws requires the main branch" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "deploy:aws requires a clean checkout" >&2
  exit 1
fi

git fetch origin main
previous_head="$(git rev-parse HEAD)"
git merge --ff-only origin/main
synced_head="$(git rev-parse HEAD)"
if [[ "$synced_head" != "$(git rev-parse origin/main)" ]]; then
  echo "deploy:aws refuses a local main that is ahead of or diverged from origin/main" >&2
  exit 1
fi
if [[ "$previous_head" != "$synced_head" ]]; then
  reexec_count="${HARNESS_DEPLOY_REEXEC_COUNT:-0}"
  if [[ ! "$reexec_count" =~ ^[0-9]+$ || "$reexec_count" -ge 3 ]]; then
    echo "origin/main kept changing during synchronization; rerun deploy:aws" >&2
    exit 1
  fi
  export HARNESS_DEPLOY_REEXEC_COUNT="$((reexec_count + 1))"
  exec bash "$repo_root/scripts/deploy-aws.sh" "$@"
fi
pnpm install --frozen-lockfile --ignore-scripts

ledger_table="AutoHarness-${HARNESS_DEPLOY_ENVIRONMENT}-SessionDrains"
read_ledger_key() {
  local output status
  set +e
  output="$(aws dynamodb get-item \
    --region "$AWS_REGION" \
    --table-name "$ledger_table" \
    --consistent-read \
    --key '{"scopeKey":{"S":"__session-drain-ledger__"},"recordKey":{"S":"ACTIVITY-V1"}}' \
    --query 'Item.recordKey.S' \
    --output text 2>&1)"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    printf '%s' "$output"
    return 0
  fi
  if [[ "$output" == *"ResourceNotFoundException"* ]]; then
    return 0
  fi
  echo "Could not inspect the activity ledger: $output" >&2
  return 1
}

resolve_cron_rule() {
  local rule
  rule="$(aws cloudformation list-stack-resources \
    --region "$AWS_REGION" \
    --stack-name "AutoHarness-${HARNESS_DEPLOY_ENVIRONMENT}-Runtime" \
    --query "StackResourceSummaries[?ResourceType=='AWS::Events::Rule'].PhysicalResourceId | [0]" \
    --output text)"
  if [[ -z "$rule" || "$rule" == "None" ]]; then
    echo "Could not resolve the EventBridge cron rule." >&2
    return 1
  fi
  printf '%s' "$rule"
}

resolve_cron_rule_optional() {
  local output status
  set +e
  output="$(aws cloudformation describe-stacks \
    --region "$AWS_REGION" \
    --stack-name "AutoHarness-${HARNESS_DEPLOY_ENVIRONMENT}-Runtime" \
    --query 'Stacks[0].StackName' \
    --output text 2>&1)"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    resolve_cron_rule
    return
  fi
  if [[ "$output" == *"does not exist"* ]]; then
    return 0
  fi
  echo "Could not inspect the runtime stack: $output" >&2
  return 1
}

resolve_scheduler_function() {
  local function_arn function_resource
  function_arn="$(aws events list-targets-by-rule \
    --region "$AWS_REGION" \
    --rule "$cron_rule" \
    --query 'Targets[0].Arn' \
    --output text)"
  if [[ "$function_arn" != *":function:"* ]]; then
    echo "Could not resolve the scheduler Lambda target." >&2
    return 1
  fi
  function_resource="${function_arn#*:function:}"
  printf '%s' "${function_resource%%:*}"
}

restore_scheduler_concurrency() {
  if [[ -z "$original_concurrency" || "$original_concurrency" == "None" ]]; then
    aws lambda delete-function-concurrency \
      --region "$AWS_REGION" \
      --function-name "$scheduler_function"
  else
    aws lambda put-function-concurrency \
      --region "$AWS_REGION" \
      --function-name "$scheduler_function" \
      --reserved-concurrent-executions "$original_concurrency" >/dev/null
  fi
}

ledger_record_key="$(read_ledger_key)"
if [[ "$ledger_record_key" == "ACTIVITY-V1" ]]; then
  pnpm --filter @auto-harness/cdk run update
  exit 0
fi

if [[ "$confirm_first_ledger" -ne 1 && ! -t 0 ]]; then
  echo "First ledger rollout requires confirmation; rerun with --yes-first-ledger after disabling external session admission and waiting for active sessions to finish." >&2
  exit 1
fi

cron_rule="$(resolve_cron_rule_optional)"
scheduler_fenced=0
original_concurrency=""
if [[ -n "$cron_rule" ]]; then
  aws events disable-rule --region "$AWS_REGION" --name "$cron_rule"
  echo "Disabled $cron_rule for the first ledger rollout."
  scheduler_function="$(resolve_scheduler_function)"
  original_concurrency="$(aws lambda get-function-concurrency \
    --region "$AWS_REGION" \
    --function-name "$scheduler_function" \
    --query 'ReservedConcurrentExecutions' \
    --output text)"
  aws lambda put-function-concurrency \
    --region "$AWS_REGION" \
    --function-name "$scheduler_function" \
    --reserved-concurrent-executions 0 >/dev/null
  fenced_concurrency="$(aws lambda get-function-concurrency \
    --region "$AWS_REGION" \
    --function-name "$scheduler_function" \
    --query 'ReservedConcurrentExecutions' \
    --output text)"
  if [[ "$fenced_concurrency" != "0" ]]; then
    echo "Could not verify the scheduler Lambda concurrency fence; the cron rule remains disabled." >&2
    exit 1
  fi
  scheduler_fenced=1
  scheduler_timeout="$(aws lambda get-function-configuration \
    --region "$AWS_REGION" \
    --function-name "$scheduler_function" \
    --query 'Timeout' \
    --output text)"
  if [[ ! "$scheduler_timeout" =~ ^[0-9]+$ ]]; then
    echo "Could not resolve the scheduler Lambda timeout; the cron rule and function remain fenced." >&2
    exit 1
  fi
  echo "Verified a zero-concurrency scheduler fence; waiting for its ${scheduler_timeout}s invocation timeout."
  sleep "$((scheduler_timeout + 5))"
else
  echo "No runtime stack exists; there is no old scheduler to fence."
fi

if [[ "$confirm_first_ledger" -ne 1 ]]; then
  read -r -p "Scheduler stopped. External admission is disabled and active sessions are now idle? [y/N] " answer
  if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
    if [[ "$scheduler_fenced" -eq 1 ]]; then
      restore_scheduler_concurrency
      aws events enable-rule --region "$AWS_REGION" --name "$cron_rule"
    fi
    echo "Deployment cancelled; the previous scheduler settings were restored." >&2
    exit 1
  fi
fi

if ! pnpm --filter @auto-harness/cdk run update; then
  set +e
  recovery_rule="$(resolve_cron_rule_optional)"
  if [[ -n "$recovery_rule" ]]; then
    cron_rule="$recovery_rule"
    aws events disable-rule --region "$AWS_REGION" --name "$cron_rule"
    scheduler_function="$(resolve_scheduler_function)"
    aws lambda put-function-concurrency \
      --region "$AWS_REGION" \
      --function-name "$scheduler_function" \
      --reserved-concurrent-executions 0 >/dev/null
  fi
  set -e
  echo "AWS update failed; any resolvable scheduler was left disabled and concurrency-fenced for fail-closed recovery." >&2
  exit 1
fi

cron_rule="$(resolve_cron_rule)"
if [[ "$scheduler_fenced" -eq 1 ]]; then
  scheduler_function="$(resolve_scheduler_function)"
  restore_scheduler_concurrency
fi
aws events enable-rule --region "$AWS_REGION" --name "$cron_rule"

for _ in $(seq 1 120); do
  record_key="$(read_ledger_key)"
  if [[ "$record_key" == "ACTIVITY-V1" ]]; then
    echo "AWS update complete; the session-drain activity ledger is ready."
    exit 0
  fi
  sleep 5
done

echo "AWS update completed, but the activity ledger was not ready within 10 minutes; keep external admission disabled and investigate." >&2
exit 1
