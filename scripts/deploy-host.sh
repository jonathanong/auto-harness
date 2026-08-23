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

platform="$(uname -s)"
if [[ "$platform" == "Linux" && "$(id -u)" -ne 0 ]]; then
  echo "deploy:host requires root on Linux so it can update the installed systemd service." >&2
  exit 1
fi

pnpm install --frozen-lockfile --ignore-scripts
pnpm local:daemon install-service

case "$platform" in
  Darwin) env_file="$HOME/Library/Application Support/auto-harness/host-daemon.env" ;;
  Linux) env_file="/etc/auto-harness/host-daemon.env" ;;
  *)
    echo "deploy:host currently supports macOS and Linux service environments." >&2
    exit 1
    ;;
esac

env -u HARNESS_HOST_ID -u HARNESS_API_URL -u HARNESS_API_HTTP -u HARNESS_API_KEY \
  HARNESS_ENV_FILE="$env_file" \
  pnpm local:daemon status
