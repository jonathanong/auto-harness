#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
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

case "$platform" in
  Darwin)
    pnpm local:daemon install-service
    env_file="$HOME/Library/Application Support/auto-harness/host-daemon.env"
    env -u HARNESS_HOST_ID -u HARNESS_API_URL -u HARNESS_API_HTTP -u HARNESS_API_KEY \
      HARNESS_ENV_FILE="$env_file" \
      pnpm local:daemon status
    ;;
  Linux)
    pnpm_path="$(command -v pnpm)"
    sudo env "PATH=$PATH" "$pnpm_path" local:daemon install-service
    env_file="/etc/auto-harness/host-daemon.env"
    sudo env -u HARNESS_HOST_ID -u HARNESS_API_URL -u HARNESS_API_HTTP -u HARNESS_API_KEY \
      "PATH=$PATH" HARNESS_ENV_FILE="$env_file" \
      "$pnpm_path" local:daemon status
    ;;
  *)
    echo "deploy:host currently supports macOS and Linux service environments." >&2
    exit 1
    ;;
esac
