#!/usr/bin/env bash
set -euo pipefail

# Stop the pnpm local:tmux session and DynamoDB Local.
# Does not delete git worktrees on disk.

cd "$(dirname "$0")/.."

SESSION="${LOCAL_TMUX_SESSION:-auto-harness-local}"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux kill-session -t "$SESSION"
  echo "killed tmux session $SESSION"
else
  echo "no tmux session $SESSION"
fi

for p in 7420 7421 7422; do
  for pid in $(lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null || true); do
    kill "$pid" 2>/dev/null || true
  done
done

pnpm local:dynamodb:down
