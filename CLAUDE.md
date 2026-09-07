# Claude

Read and follow [AGENTS.md](./AGENTS.md). Product and contributor entry points: [README.md](./README.md), [docs/README.md](docs/README.md).

## Invariant: the control plane must do everything; the host pane is debug-only

Hosts connect to the control plane over WebSocket only — the control plane has no reachable
address for a host (no guaranteed `:7422` URL reachable in a real fleet). A user must be able to
do everything they need for any host (attach/edit repositories, add/remove/edit worktrees,
manage command profiles, etc.) **from the control plane (`services/web`)**. The host pane
(`services/host-pane`, port `:7422`) exists only for local debugging on that host — never design
a feature that requires opening the host pane to accomplish something the control plane could
do instead. See [docs/plan.md](docs/plan.md#5-invariants) invariant 10.

## Invariant: session orchestration is package-manager-agnostic

The host daemon never detects repository manifests or lockfiles, and never invokes a repository
package manager. For a fresh session it checks out the assigned ref, runs only explicitly
configured trusted setup scripts, then launches the resolved command. Dependency installation and
toolchain preparation belong to those setup scripts. Native resumes continue to skip setup. See
[docs/plan.md](docs/plan.md#5-invariants) invariant 11.

## Invariant: browser and host never share a request lifetime

A browser REST or viewer-WebSocket invocation may read and write DynamoDB and return. A host
WebSocket invocation may read and write DynamoDB and return. Pushes to a host (`postToHost`) or
to a browser viewer (`PostToConnection`) run in a **different** invocation — async Lambda, cron,
or an indexed fan-out. Do not `await` assignment, ack, log replay, or host filesystem/git inside
a browser request. Do not Scan the Connections table in order to talk to one host or one
session's viewers. See [docs/plan.md](docs/plan.md#5-invariants) invariant 12.

## Invariant: list and history APIs page or stream at storage

`limit` / `nextCursor` (or a log cursor / viewer tail) must bound the DynamoDB read. Scanning a
table and slicing in memory is not pagination. UIs show one page and Load more. Do not collect
every cursor page except for small catalogs that are explicitly documented as complete, and even
those need a cap. Live logs: REST history is a bounded newest page; the viewer WebSocket is
tail-only and never replays REST history. See [docs/plan.md](docs/plan.md#5-invariants)
invariant 13.
