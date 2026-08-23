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
git merge --ff-only origin/main
pnpm install --frozen-lockfile

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

ledger_record_key="$(read_ledger_key)"
if [[ "$ledger_record_key" == "ACTIVITY-V1" ]]; then
  pnpm --filter @auto-harness/cdk run update
  exit 0
fi

if [[ "$confirm_first_ledger" -ne 1 ]]; then
  if [[ ! -t 0 ]]; then
    echo "First ledger rollout requires confirmation; rerun with --yes-first-ledger after disabling external session admission and waiting for active sessions to finish." >&2
    exit 1
  fi
  read -r -p "External session admission is disabled and active sessions are idle? [y/N] " answer
  if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
    echo "Deployment cancelled." >&2
    exit 1
  fi
fi

cron_rule="$(resolve_cron_rule)"

aws events disable-rule --region "$AWS_REGION" --name "$cron_rule"
echo "Disabled $cron_rule for the first ledger rollout."
echo "Waiting one cron timeout so no old scheduler invocation overlaps the rollout."
sleep 65

if ! pnpm --filter @auto-harness/cdk run update; then
  echo "AWS update failed; $cron_rule remains disabled for fail-closed recovery." >&2
  exit 1
fi

cron_rule="$(resolve_cron_rule)"
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
