# Claude

Read and follow [AGENTS.md](./AGENTS.md).

## Invariant: the control plane must do everything; the host pane is debug-only

Hosts connect to the control plane over WebSocket only — the control plane has no reachable
address for a host (no guaranteed `:7422` URL reachable in a real fleet). A user must be able to
do everything they need for any host (attach/edit repositories, add/remove/edit worktrees,
manage command profiles, etc.) **from the control plane (`services/web`)**. The host pane
(`services/agent-web`, port `:7422`) exists only for local debugging on that host — never design
a feature that requires opening the host pane to accomplish something the control plane could
do instead. See [docs/plan.md](docs/plan.md#5-invariants) invariant 10.
