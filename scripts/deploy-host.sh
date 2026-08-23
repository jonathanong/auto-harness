#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

validate_linux_checkout() {
  local platform="$1" checkout_root="$2" service_checkout="$3" service_root
  if [[ "$platform" != "Linux" || ! -e "$service_checkout" ]]; then
    return 0
  fi
  service_root="$(cd "$service_checkout" && pwd -P)"
  if [[ "$checkout_root" != "$service_root" ]]; then
    echo "deploy:host must run from $service_checkout because the installed Linux service executes that checkout." >&2
    return 1
  fi
}

wait_for_host_readiness() {
  local timeout_seconds="$1" deadline output status remaining_seconds
  shift
  if [[ ! "$timeout_seconds" =~ ^[0-9]+$ || "$timeout_seconds" -lt 1 || "$timeout_seconds" -gt 120 ]]; then
    echo "Host readiness timeout must be between 1 and 120 seconds." >&2
    return 1
  fi
  deadline=$((SECONDS + timeout_seconds))
  output=""
  while true; do
    remaining_seconds=$((deadline - SECONDS))
    if [[ "$remaining_seconds" -le 0 ]]; then
      break
    fi
    set +e
    output="$(node "$repo_root/scripts/run-command-with-timeout.mts" \
      "$remaining_seconds" -- "$@" 2>&1)"
    status=$?
    set -e
    if [[ "$status" -eq 0 ]]; then
      printf '%s\n' "$output"
      return 0
    fi
    if [[ "$status" -eq 124 || "$SECONDS" -ge "$deadline" ]]; then
      break
    fi
    remaining_seconds=$((deadline - SECONDS))
    if [[ "$remaining_seconds" -gt 0 ]]; then
      sleep "$((remaining_seconds < 2 ? remaining_seconds : 2))"
    fi
  done
  printf '%s\n' "$output" >&2
  echo "Host service did not become ready within $timeout_seconds seconds." >&2
  return 1
}

main() {
  cd "$repo_root"
  if [[ "${1:-}" == "--" ]]; then
    shift
  fi

  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    cat <<'EOF'
Usage: pnpm deploy:host

Installs locked dependencies, rewrites/restarts the persisted host service from
this checkout, and verifies the installed production identity without printing
its API key.
EOF
    exit 0
  fi
  if [[ -n "${1:-}" ]]; then
    echo "Usage: pnpm deploy:host" >&2
    exit 2
  fi

  platform="$(uname -s)"
  if [[ "$platform" == "Linux" && "$(id -u)" -eq 0 ]]; then
    echo "deploy:host must run as the checkout owner on Linux; it elevates only the systemd operations." >&2
    exit 1
  fi
  validate_linux_checkout "$platform" "$(pwd -P)" /opt/auto-harness/current

  if [[ "$(git branch --show-current)" != "main" ]]; then
    echo "deploy:host requires the main branch" >&2
    exit 1
  fi
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "deploy:host requires a clean checkout" >&2
    exit 1
  fi
  git fetch origin main
  if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
    echo "deploy:host requires main at origin/main; run pnpm deploy:aws first." >&2
    exit 1
  fi

  pnpm install --frozen-lockfile --ignore-scripts
  pnpm run prepare:test:platform

  case "$platform" in
    Darwin)
      pnpm local:daemon install-service
      env_file="$HOME/Library/Application Support/auto-harness/host-daemon.env"
      wait_for_host_readiness 120 env \
        -u HARNESS_HOST_ID -u HARNESS_API_URL -u HARNESS_API_HTTP -u HARNESS_API_KEY \
        HARNESS_ENV_FILE="$env_file" \
        pnpm local:daemon status
      ;;
    Linux)
      pnpm_path="$(command -v pnpm)"
      sudo env "PATH=$PATH" "$pnpm_path" local:daemon install-service
      env_file="/etc/auto-harness/host-daemon.env"
      wait_for_host_readiness 120 sudo env \
        -u HARNESS_HOST_ID -u HARNESS_API_URL -u HARNESS_API_HTTP -u HARNESS_API_KEY \
        "PATH=$PATH" HARNESS_ENV_FILE="$env_file" \
        "$pnpm_path" local:daemon status
      ;;
    *)
      echo "deploy:host currently supports macOS and Linux service environments." >&2
      exit 1
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
