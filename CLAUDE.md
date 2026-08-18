# Claude

Read and follow [AGENTS.md](./AGENTS.md).

## Invariant: the control plane must do everything; the host pane is debug-only

Hosts connect to the control plane over WebSocket only — the control plane has no reachable
address for a host (no guaranteed `:7422` URL reachable in a real fleet). A user must be able to
do everything they need for any host (attach/edit repositories, add/remove/edit worktrees,
manage command profiles, etc.) **from the control plane (`services/web`)**. The host pane
(`services/host-pane`, port `:7422`) exists only for local debugging on that host — never design
a feature that requires opening the host pane to accomplish something the control plane could
do instead. See [docs/plan.md](docs/plan.md#5-invariants) invariant 10.

## Working in a git worktree, or alongside other agents

This repo is regularly checked out into several git worktrees at once, each possibly running its
own agent, dev server, or e2e run concurrently. **Never guess a port offset or reuse another
run's DynamoDB container by hand** — two worktrees on the same fixed ports silently corrupt each
other's runs, or point a stale build at the wrong backend. Use
[`scripts/worktree-e2e-env.mts`](scripts/worktree-e2e-env.mts) — see
[docs/e2e.md#isolated-focused-control-runs](docs/e2e.md#isolated-focused-control-runs) — which
derives a deterministic, worktree-specific port block from the worktree's own directory name, so
concurrent worktrees never collide and the same worktree gets stable, reusable ports across runs.
