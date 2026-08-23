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
external session admission is disabled. The command verifies zero active
sessions itself after fencing the old scheduler.
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
sessions_table="AutoHarness-${HARNESS_DEPLOY_ENVIRONMENT}-Sessions"
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

resolve_runtime_function() {
  local logical_prefix="$1" function_name
  function_name="$(aws cloudformation list-stack-resources \
    --region "$AWS_REGION" \
    --stack-name "AutoHarness-${HARNESS_DEPLOY_ENVIRONMENT}-Runtime" \
    --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function' && starts_with(LogicalResourceId, '${logical_prefix}')].PhysicalResourceId | [0]" \
    --output text)"
  if [[ -z "$function_name" || "$function_name" == "None" ]]; then
    echo "Could not resolve the ${logical_prefix} Lambda." >&2
    return 1
  fi
  printf '%s' "$function_name"
}

read_lambda_timeout() {
  local function_name="$1" timeout
  timeout="$(aws lambda get-function-configuration \
    --region "$AWS_REGION" \
    --function-name "$function_name" \
    --query 'Timeout' \
    --output text)"
  if [[ ! "$timeout" =~ ^[0-9]+$ ]]; then
    echo "Could not resolve the $function_name Lambda timeout." >&2
    return 1
  fi
  printf '%s' "$timeout"
}

wait_for_external_admission_writers() {
  local rest_function websocket_function rest_timeout websocket_timeout writer_timeout
  rest_function="$(resolve_runtime_function RestFunction)"
  websocket_function="$(resolve_runtime_function WebSocketFunction)"
  rest_timeout="$(read_lambda_timeout "$rest_function")"
  websocket_timeout="$(read_lambda_timeout "$websocket_function")"
  writer_timeout="$rest_timeout"
  if [[ "$websocket_timeout" -gt "$writer_timeout" ]]; then
    writer_timeout="$websocket_timeout"
  fi
  echo "External admission is disabled; waiting for the old REST and WebSocket writers' ${writer_timeout}s invocation timeout."
  sleep "$((writer_timeout + 5))"
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

read_rule_state() {
  local state
  state="$(aws events describe-rule \
    --region "$AWS_REGION" \
    --name "$cron_rule" \
    --query 'State' \
    --output text)"
  if [[ "$state" != "ENABLED" && "$state" != "DISABLED" ]]; then
    echo "Could not resolve the original EventBridge rule state." >&2
    return 1
  fi
  printf '%s' "$state"
}

restore_rule_state() {
  if [[ "$original_rule_state" == "DISABLED" ]]; then
    aws events disable-rule --region "$AWS_REGION" --name "$cron_rule"
  else
    aws events enable-rule --region "$AWS_REGION" --name "$cron_rule"
  fi
}

verify_no_active_sessions() {
  local active_session_ids
  active_session_ids="$(aws dynamodb scan \
    --region "$AWS_REGION" \
    --table-name "$sessions_table" \
    --consistent-read \
    --projection-expression 'id,#status' \
    --filter-expression '#status IN (:queued,:running) OR (#status = :cancelled AND (attribute_type(worktreeId,:stringType) OR mainCheckoutLease = :true))' \
    --expression-attribute-names '{"#status":"status"}' \
    --expression-attribute-values '{":queued":{"S":"queued"},":running":{"S":"running"},":cancelled":{"S":"cancelled"},":stringType":{"S":"S"},":true":{"BOOL":true}}' \
    --query 'Items[].id.S' \
    --output text)"
  if [[ -n "$active_session_ids" && "$active_session_ids" != "None" ]]; then
    echo "Active sessions remain after the scheduler fence; keep external admission disabled, wait for them to settle, and rerun." >&2
    return 1
  fi
  echo "Verified zero drain-affecting sessions after fencing the scheduler."
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
original_rule_state=""
if [[ -n "$cron_rule" ]]; then
  original_rule_state="$(read_rule_state)"
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
  read -r -p "Scheduler stopped. External admission is disabled? [y/N] " answer
  if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
    if [[ "$scheduler_fenced" -eq 1 ]]; then
      restore_scheduler_concurrency
      restore_rule_state
    fi
    echo "Deployment cancelled; the previous scheduler settings were restored." >&2
    exit 1
  fi
fi

if [[ -n "$cron_rule" ]]; then
  wait_for_external_admission_writers
fi
verify_no_active_sessions

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
rule_restore_pending=0
# Invoked indirectly by the EXIT trap below.
# shellcheck disable=SC2329
restore_original_rule_on_exit() {
  local status=$?
  if [[ "$rule_restore_pending" -eq 1 ]]; then
    local restore_status
    set +e
    restore_rule_state
    restore_status=$?
    if [[ "$restore_status" -ne 0 ]]; then
      echo "Could not restore the original EventBridge rule state; external admission must remain disabled while an operator restores it." >&2
    fi
  fi
  exit "$status"
}
finish_rule_restoration() {
  if [[ "$rule_restore_pending" -eq 1 ]]; then
    restore_rule_state
    rule_restore_pending=0
    trap - EXIT
  fi
}
if [[ -n "$original_rule_state" ]]; then
  rule_restore_pending=1
  trap restore_original_rule_on_exit EXIT
fi
node scripts/migrate-session-drain-ledger.mts
record_key="$(read_ledger_key)"
if [[ "$record_key" != "ACTIVITY-V1" ]]; then
  echo "AWS update completed, but the bounded migration driver did not publish the activity-ledger readiness marker; keep external admission disabled and investigate." >&2
  exit 1
fi
finish_rule_restoration
echo "AWS update complete; the session-drain activity ledger is ready."
