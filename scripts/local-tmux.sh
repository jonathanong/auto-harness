#!/usr/bin/env bash
set -euo pipefail

# pnpm local:tmux — every local dev service, one tmux window each.
# DynamoDB Local is the exception: it's a Docker container, not a foreground
# process, so it starts in the background here rather than getting its own window.
#
# Windows (left to right, matching the port order — see docs/local-development.md):
#   api        :7420  pnpm local:api
#   web        :7421  pnpm local:web        (control plane)
#   host-pane  :7422  pnpm local:host-pane  (host pane)
#   daemon     —      pnpm local:daemon start

cd "$(dirname "$0")/.."

if ! command -v tmux >/dev/null 2>&1; then
  echo "Error: tmux is not installed. Install: brew install tmux (macOS) or apt-get install tmux (Linux)" >&2
  exit 1
fi

SESSION="${LOCAL_TMUX_SESSION:-auto-harness-local}"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session '$SESSION' already exists — attaching (services are not restarted)."
  if [ -n "${TMUX:-}" ]; then
    exec tmux switch-client -t "$SESSION"
  fi
  exec tmux attach-session -t "$SESSION"
fi

echo "Starting DynamoDB Local in the background (Docker, :7423)..."
pnpm local:dynamodb
pnpm local:dynamodb:ready

tmux new-session -d -s "$SESSION" -n api "pnpm local:api"
tmux new-window -t "$SESSION" -n web "pnpm local:web"
tmux new-window -t "$SESSION" -n host-pane "pnpm local:host-pane"
# The host daemon connects to the API's WebSocket on startup and exits (closing
# the window) if that fails, so wait for /health before launching it.
tmux new-window -t "$SESSION" -n daemon \
  "until curl -fsS http://127.0.0.1:7420/health >/dev/null 2>&1; do sleep 1; done; pnpm local:daemon start"
tmux select-window -t "$SESSION:api"

if [ -n "${TMUX:-}" ]; then
  exec tmux switch-client -t "$SESSION"
fi
exec tmux attach-session -t "$SESSION"
